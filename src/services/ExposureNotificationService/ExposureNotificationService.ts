import ExposureNotification, {
  ExposureSummary,
  Status as SystemStatus,
  ExposureConfiguration,
  TemporaryExposureKey,
} from 'bridge/ExposureNotification';
import PushNotification from 'bridge/PushNotification';
import {addDays, periodSinceEpoch, minutesBetween, getCurrentDate, daysBetweenUTC, daysBetween} from 'shared/date-fns';
import {I18n} from 'locale';
import {Observable, MapObservable} from 'shared/Observable';
import {captureException, captureMessage} from 'shared/log';
import {Platform} from 'react-native';
import {ContagiousDateInfo} from 'screens/datasharing/components';
import AsyncStorage from '@react-native-community/async-storage';

import {BackendInterface, SubmissionKeySet} from '../BackendService';

import exposureConfigurationDefault from './ExposureConfigurationDefault.json';
import exposureConfigurationSchema from './ExposureConfigurationSchema.json';
import {ExposureConfigurationValidator, ExposureConfigurationValidationError} from './ExposureConfigurationValidator';

const SUBMISSION_AUTH_KEYS = 'submissionAuthKeys';
const EXPOSURE_CONFIGURATION = 'exposureConfiguration';

export const EXPOSURE_STATUS = 'exposureStatus';

export const LAST_EXPOSURE_TIMESTAMP_KEY = 'lastExposureTimestamp';

export const HOURS_PER_PERIOD = 24;

export const EXPOSURE_NOTIFICATION_CYCLE = 14;

export const MINIMUM_REMINDER_INTERVAL_MINUTES = 180;

export const cannotGetTEKsError = new Error('Unable to retrieve TEKs');

export {SystemStatus};

export enum ExposureStatusType {
  Monitoring = 'monitoring',
  Exposed = 'exposed',
  Diagnosed = 'diagnosed',
}

export type ExposureStatus =
  | {
      type: ExposureStatusType.Monitoring;
      lastChecked?: {
        period: number;
        timestamp: number;
      };
    }
  | {
      type: ExposureStatusType.Exposed;
      summary: ExposureSummary;
      notificationSent?: boolean;
      lastChecked?: {
        period: number;
        timestamp: number;
      };
    }
  | {
      type: ExposureStatusType.Diagnosed;
      needsSubmission: boolean;
      submissionLastCompletedAt?: number;
      uploadReminderLastSentAt?: number;
      cycleStartsAt: number;
      cycleEndsAt: number;
      lastChecked?: {
        period: number;
        timestamp: number;
      };
    };

export interface PersistencyProvider {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
}

export interface SecurePersistencyProvider {
  set(key: string, value: string, options: SecureStorageOptions): Promise<null>;
  get(key: string): Promise<string | null>;
}

export interface SecureStorageOptions {
  accessible?: string;
}

export class ExposureNotificationService {
  systemStatus: Observable<SystemStatus>;
  exposureStatus: MapObservable<ExposureStatus>;

  /**
   * Visible for testing only
   * We can make this private until ExposureNotificationClient.ACTION_EXPOSURE_NOT_FOUND is available in Android EN framework
   * Ref https://developers.google.com/android/exposure-notifications/exposure-notifications-api#broadcast-receivers
   **/
  exposureStatusUpdatePromise: Promise<void> | null = null;

  private starting = false;

  private exposureNotification: typeof ExposureNotification;
  private backendInterface: BackendInterface;

  private i18n: I18n;
  private storage: PersistencyProvider;
  private secureStorage: SecurePersistencyProvider;

  constructor(
    backendInterface: BackendInterface,
    i18n: I18n,
    storage: PersistencyProvider,
    secureStorage: SecurePersistencyProvider,
    exposureNotification: typeof ExposureNotification,
  ) {
    this.i18n = i18n;
    this.exposureNotification = exposureNotification;
    this.systemStatus = new Observable<SystemStatus>(SystemStatus.Undefined);
    this.exposureStatus = new MapObservable<ExposureStatus>({type: ExposureStatusType.Monitoring});
    this.backendInterface = backendInterface;
    this.storage = storage;
    this.secureStorage = secureStorage;
    this.exposureStatus.observe(status => {
      this.storage.setItem(EXPOSURE_STATUS, JSON.stringify(status));
    });
  }

  async start(): Promise<void> {
    if (this.starting) {
      return;
    }

    this.starting = true;

    await this.loadExposureStatus();

    try {
      await this.exposureNotification.start();
    } catch (error) {
      captureException('Cannot start EN framework', error);
    }

    await this.updateSystemStatus();

    this.starting = false;
    await this.updateExposureStatus();
  }

  async updateSystemStatus(): Promise<void> {
    const status = await this.exposureNotification.getStatus();
    this.systemStatus.set(status);
  }

  async updateExposureStatusInBackground() {
    await this.loadExposureStatus();
    try {
      captureMessage('updateExposureStatusInBackground', {exposureStatus: this.exposureStatus.get()});
      await this.updateExposureStatus();
      await this.processNotification();
      captureMessage('updatedExposureStatusInBackground', {exposureStatus: this.exposureStatus.get()});
    } catch (error) {
      captureException('updateExposureStatusInBackground', error);
    }
  }

  /*
    Filter and sort the summaries.
    This may change in the future because of EN Framework changes.
  */
  public summariesContainingExposures(
    minimumExposureDurationMinutes: number,
    summaries: ExposureSummary[],
  ): ExposureSummary[] {
    return summaries
      .filter(summary => {
        return this.summaryExceedsMinimumMinutes(summary, minimumExposureDurationMinutes);
      })
      .sort((summary1, summary2) => {
        return summary2.lastExposureTimestamp - summary1.lastExposureTimestamp;
      });
  }

  public isReminderNeeded(exposureStatus: ExposureStatus) {
    if (exposureStatus.type !== ExposureStatusType.Diagnosed) {
      return false;
    }

    if (!exposureStatus.needsSubmission) {
      return false;
    }

    if (!exposureStatus.uploadReminderLastSentAt) {
      return true;
    }

    const lastSent = new Date(exposureStatus.uploadReminderLastSentAt);
    const today = getCurrentDate();
    const mins = minutesBetween(lastSent, today);
    return mins > MINIMUM_REMINDER_INTERVAL_MINUTES;
  }

  async updateExposureStatus(): Promise<void> {
    if (this.exposureStatusUpdatePromise) return this.exposureStatusUpdatePromise;
    const cleanUpPromise = <T>(input: T): T => {
      this.exposureStatusUpdatePromise = null;
      return input;
    };
    this.exposureStatusUpdatePromise = this.performExposureCheck().then(cleanUpPromise, cleanUpPromise);
    return this.exposureStatusUpdatePromise;
  }

  async startKeysSubmission(oneTimeCode: string): Promise<void> {
    const keys = await this.backendInterface.claimOneTimeCode(oneTimeCode);
    const serialized = JSON.stringify(keys);
    try {
      await this.secureStorage.set(SUBMISSION_AUTH_KEYS, serialized, {});
    } catch (error) {
      captureException('Unable to store SUBMISSION_AUTH_KEYS', error);
    }
    const cycleStartsAt = getCurrentDate();
    this.exposureStatus.append({
      type: ExposureStatusType.Diagnosed,
      needsSubmission: true,
      cycleStartsAt: cycleStartsAt.getTime(),
      cycleEndsAt: addDays(cycleStartsAt, EXPOSURE_NOTIFICATION_CYCLE).getTime(),
    });
  }

  async fetchAndSubmitKeys(contagiousDateInfo: ContagiousDateInfo): Promise<void> {
    const submissionKeysStr = await this.secureStorage.get(SUBMISSION_AUTH_KEYS);
    if (!submissionKeysStr) {
      throw new Error('Submission keys: bad certificate');
    }
    const auth = JSON.parse(submissionKeysStr) as SubmissionKeySet;
    let temporaryExposureKeys: TemporaryExposureKey[];
    try {
      temporaryExposureKeys = await this.exposureNotification.getTemporaryExposureKeyHistory();
    } catch (error) {
      captureException('getTemporaryExposureKeyHistory', error);
      throw cannotGetTEKsError;
    }
    if (temporaryExposureKeys.length > 0) {
      captureMessage('getTemporaryExposureKeyHistory', temporaryExposureKeys);
      await this.backendInterface.reportDiagnosisKeys(auth, temporaryExposureKeys, contagiousDateInfo);
    } else {
      captureMessage('No TEKs available to upload');
    }
    await this.recordKeySubmission();
  }

  private async loadExposureStatus() {
    // using a string with the value of 'null'
    const exposureStatus = JSON.parse((await this.storage.getItem(EXPOSURE_STATUS)) || 'null');
    this.exposureStatus.append({...exposureStatus});
  }

  /**
   * If the exposureConfiguration is not available from the server for some reason,
   * try and use a previously stored configuration, or use the default configuration bundled with the app.
   */
  private async getAlternateExposureConfiguration(): Promise<ExposureConfiguration> {
    try {
      captureMessage('Getting exposure configuration from secure storage.');
      const exposureConfigurationStr = await this.storage.getItem(EXPOSURE_CONFIGURATION);
      if (exposureConfigurationStr) {
        return JSON.parse(exposureConfigurationStr);
      } else {
        throw new Error('Unable to use saved exposureConfiguration');
      }
    } catch (error) {
      captureException('Using default exposureConfiguration', error);
      return exposureConfigurationDefault;
    }
  }

  private async recordKeySubmission() {
    const currentStatus = this.exposureStatus.get();
    if (currentStatus.type !== ExposureStatusType.Diagnosed) return;
    this.exposureStatus.append({needsSubmission: false, submissionLastCompletedAt: getCurrentDate().getTime()});
  }

  private async calculateNeedsSubmission(): Promise<boolean> {
    const exposureStatus = this.exposureStatus.get();
    if (exposureStatus.type !== ExposureStatusType.Diagnosed) return false;

    const today = getCurrentDate();
    const cycleEndsAt = new Date(exposureStatus.cycleEndsAt);
    // We're done submitting keys
    // This has to be based on UTC timezone https://github.com/cds-snc/covid-shield-mobile/issues/676
    if (daysBetweenUTC(today, cycleEndsAt) <= 0) return false;

    const submissionLastCompletedAt = exposureStatus.submissionLastCompletedAt;
    if (!submissionLastCompletedAt) return true;

    const lastSubmittedDay = new Date(submissionLastCompletedAt);

    // This has to be based on UTC timezone https://github.com/cds-snc/covid-shield-mobile/issues/676
    if (daysBetweenUTC(lastSubmittedDay, today) > 0) return true;

    return false;
  }

  private async *keysSinceLastFetch(
    _lastCheckedPeriod?: number,
  ): AsyncGenerator<{keysFileUrl: string; period: number} | null> {
    const runningDate = getCurrentDate();
    let runningPeriod = periodSinceEpoch(runningDate, HOURS_PER_PERIOD);

    if (!_lastCheckedPeriod) {
      try {
        const keysFileUrl = await this.backendInterface.retrieveDiagnosisKeys(0);
        yield {keysFileUrl, period: runningPeriod};
      } catch (error) {
        captureException('Error while downloading batch files', error);
      }
      return;
    }

    const lastCheckedPeriod = Math.max(_lastCheckedPeriod - 1, runningPeriod - EXPOSURE_NOTIFICATION_CYCLE);

    while (runningPeriod > lastCheckedPeriod) {
      try {
        const keysFileUrl = await this.backendInterface.retrieveDiagnosisKeys(runningPeriod);
        const period = runningPeriod;
        yield {keysFileUrl, period};
      } catch (error) {
        captureException('Error while downloading key file', error);
      }

      runningPeriod -= 1;
    }
  }

  private finalize = async (
    status: Partial<ExposureStatus> = {},
    lastCheckedPeriod: number | undefined = undefined,
  ) => {
    const previousExposureStatus = this.exposureStatus.get();
    const timestamp = getCurrentDate().getTime();
    let period;
    if (lastCheckedPeriod === undefined) {
      period = status.lastChecked?.period || previousExposureStatus.lastChecked?.period || 0;
    } else {
      period = lastCheckedPeriod;
    }
    this.exposureStatus.append({
      ...status,
      lastChecked: {
        timestamp,
        period,
      },
    });
    const currentExposureStatus = this.exposureStatus.get();
    captureMessage('finalize', {
      previousExposureStatus,
      currentExposureStatus,
    });
  };

  private setToExposed = async (summary: ExposureSummary, lastCheckedPeriod: any) => {
    captureMessage('setToExposed ', {summary});

    AsyncStorage.setItem(LAST_EXPOSURE_TIMESTAMP_KEY, summary.lastExposureTimestamp.toString());
    return this.finalize(
      {
        type: ExposureStatusType.Exposed,
        summary: this.selectExposureSummary(summary),
      },
      lastCheckedPeriod,
    );
  };

  private async setToMonitoring() {
    captureMessage('setToMonitoring');
    await this.finalize({type: ExposureStatusType.Monitoring});
  }

  private async updateExposure() {
    const currentStatus = this.exposureStatus.get();
    const today = getCurrentDate();
    switch (currentStatus.type) {
      case ExposureStatusType.Diagnosed:
        // eslint-disable-next-line no-case-declarations
        const cycleEndsAt = new Date(currentStatus.cycleEndsAt);
        // There is a case where using UTC and device timezone could mess up user experience. See `date-fn.spec.ts`
        // Let's use device timezone for resetting exposureStatus for now
        // Ref https://github.com/cds-snc/covid-shield-mobile/issues/676
        if (daysBetween(today, cycleEndsAt) <= 0) {
          await this.setToMonitoring();
          return;
        }
        return this.finalize({needsSubmission: await this.calculateNeedsSubmission()});
      case ExposureStatusType.Exposed:
        // eslint-disable-next-line no-case-declarations
        const lastExposureTimestamp = await this.getStoredLastExposureTimestamp();
        if (!lastExposureTimestamp) {
          break;
        }
        if (daysBetween(lastExposureTimestamp, today) >= EXPOSURE_NOTIFICATION_CYCLE) {
          captureMessage('setToMonitoring EXPOSURE_NOTIFICATION_CYCLE');
          await this.setToMonitoring();
        }
        break;
    }
  }

  private async getStoredLastExposureTimestamp() {
    const exposureStatus = this.exposureStatus.get();
    if (exposureStatus.type !== ExposureStatusType.Exposed) {
      return;
    }

    const lastExposureTimestampStr = await AsyncStorage.getItem(LAST_EXPOSURE_TIMESTAMP_KEY);
    if (lastExposureTimestampStr) {
      captureMessage('getStoredLastExposureTimestamp', {lastExposureTimestampStr});
      return new Date(parseInt(lastExposureTimestampStr, 10));
    }

    const lastExposureTimestamp = exposureStatus.summary.lastExposureTimestamp;
    if (lastExposureTimestamp) {
      captureMessage('getStoredLastExposureTimestamp get from summary', {
        lastExposureTimestampStr: exposureStatus.summary.lastExposureTimestamp,
      });
      return new Date(lastExposureTimestamp);
    }
    const today = getCurrentDate();
    captureMessage('getStoredLastExposureTimestamp get from today', {
      lastExposureTimestampStr: today,
    });
    await AsyncStorage.setItem(LAST_EXPOSURE_TIMESTAMP_KEY, today.getTime().toString());
    return today;
  }

  private summaryExceedsMinimumMinutes(summary: ExposureSummary, minimumExposureDurationMinutes: number) {
    captureMessage('summaryExceedsMinimumMinutes', summary);
    // on ios attenuationDurations is in seconds, on android it is in minutes
    const divisor = Platform.OS === 'ios' ? 60 : 1;
    const durationAtImmediateMinutes = summary.attenuationDurations[0] / divisor;
    const durationAtNearMinutes = summary.attenuationDurations[1] / divisor;
    const exposureDurationMinutes = durationAtImmediateMinutes + durationAtNearMinutes;

    return minimumExposureDurationMinutes && Math.round(exposureDurationMinutes) >= minimumExposureDurationMinutes;
  }

  private async getSummariesFromEnFramework(
    exposureConfiguration: ExposureConfiguration,
  ): Promise<{summaries: ExposureSummary[]; lastCheckedPeriod: any}> {
    let summaries: ExposureSummary[];
    let lastCheckedPeriod: any;
    const today = getCurrentDate();

    try {
      // a pending summary is on Android only.
      const pendingSummaries = await this.exposureNotification.getPendingExposureSummary();
      if (pendingSummaries && pendingSummaries.length > 0) {
        lastCheckedPeriod = {
          timestamp: today.getTime(),
          period: periodSinceEpoch(today, HOURS_PER_PERIOD),
        };
        summaries = pendingSummaries;
      } else {
        const currentStatus = this.exposureStatus.get();
        await this.updateExposure();

        const keysAndLastChecked = await this.getKeys(currentStatus.lastChecked);
        lastCheckedPeriod = keysAndLastChecked.lastChecked;

        summaries = await this.exposureNotification.detectExposure(exposureConfiguration, keysAndLastChecked.keys);
      }
      return {summaries, lastCheckedPeriod};
    } catch (error) {
      captureException('getSummaries', error);
      return {summaries: [], lastCheckedPeriod: null};
    }
  }

  private async performExposureCheck(): Promise<void> {
    const exposureConfiguration = await this.getExposureConfiguration();

    const {summaries, lastCheckedPeriod} = await this.getSummariesFromEnFramework(exposureConfiguration);

    const summariesContaingExposures = this.summariesContainingExposures(
      exposureConfiguration.minimumExposureDurationMinutes,
      summaries,
    );
    if (summariesContaingExposures.length > 0) {
      await this.setToExposed(summariesContaingExposures[0], lastCheckedPeriod);
      return;
    }

    return this.finalize();
  }

  private async getKeys(lastChecked: any) {
    const keys: string[] = [];
    const generator = this.keysSinceLastFetch(lastChecked?.period);
    let lastCheckedPeriod = lastChecked?.period;
    while (true) {
      const {value, done} = await generator.next();
      if (done) break;
      if (!value) continue;
      const {keysFileUrl, period} = value;
      keys.push(keysFileUrl);
      lastCheckedPeriod = Math.max(lastCheckedPeriod || 0, period);
    }
    return {keys, lastChecked};
  }

  private async getExposureConfiguration(): Promise<ExposureConfiguration> {
    // TODO: refactor getExposure
    // get the exposureconfiguration using etag
    let exposureConfiguration: ExposureConfiguration;
    try {
      exposureConfiguration = await this.backendInterface.getExposureConfiguration();
      new ExposureConfigurationValidator().validateExposureConfiguration(
        exposureConfiguration,
        exposureConfigurationSchema,
      );
      captureMessage('Using downloaded exposureConfiguration.');
      const serialized = JSON.stringify(exposureConfiguration);
      await this.storage.setItem(EXPOSURE_CONFIGURATION, serialized);
      captureMessage('Saving exposure configuration to secure storage.');
    } catch (error) {
      if (error instanceof SyntaxError) {
        captureException('JSON Parsing Error: Unable to parse downloaded exposureConfiguration', error);
      } else if (error instanceof ExposureConfigurationValidationError) {
        captureException('JSON Schema Error: ', error);
      } else {
        captureException('Network Error: Unable to download exposureConfiguration.', error);
      }
      exposureConfiguration = await this.getAlternateExposureConfiguration();
    }
    return exposureConfiguration;
  }

  private selectExposureSummary(nextSummary: ExposureSummary): ExposureSummary {
    const exposureStatus = this.exposureStatus.get();
    if (exposureStatus.type !== ExposureStatusType.Exposed) {
      captureMessage('selectExposureSummary use nextSummary', {nextSummary});
      return nextSummary;
    }
    const currentSummary = exposureStatus.summary;
    captureMessage('selectExposureSummary use currentSummary', {currentSummary});
    return currentSummary;
  }

  private async processNotification() {
    const exposureStatus = this.exposureStatus.get();

    if (exposureStatus.type === ExposureStatusType.Exposed && !exposureStatus.notificationSent) {
      PushNotification.presentLocalNotification({
        alertTitle: this.i18n.translate('Notification.ExposedMessageTitle'),
        alertBody: this.i18n.translate('Notification.ExposedMessageBody'),
      });
      await this.exposureStatus.append({
        notificationSent: true,
      });
    }

    if (this.isReminderNeeded(exposureStatus)) {
      PushNotification.presentLocalNotification({
        alertTitle: this.i18n.translate('Notification.DailyUploadNotificationTitle'),
        alertBody: this.i18n.translate('Notification.DailyUploadNotificationBody'),
      });

      await this.exposureStatus.append({
        uploadReminderLastSentAt: new Date().getTime(),
      });
    }
  }
}
