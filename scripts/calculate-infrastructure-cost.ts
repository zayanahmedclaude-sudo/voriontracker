const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getField(model, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => acc?.[key], model);
}

function getValue(model, dottedPath, required = true) {
  const field = getField(model, dottedPath);
  if (!field || typeof field !== 'object' || !('value' in field)) {
    if (!required) return null;
    throw new Error(`Missing model field: ${dottedPath}`);
  }
  return field.value;
}

function formatNumber(value, digits = 2) {
  return Number(value || 0).toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatMaybeMoney(value) {
  if (value == null || Number.isNaN(value)) return 'price not configured';
  return `$${formatNumber(value)}`;
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function validateModel(model) {
  const required = [
    'workSchedule.workingDaysPerMonth',
    'workSchedule.workingHoursPerDay',
    'employeeScenarios.counts',
    'intervals.screenshotCaptureSeconds',
    'intervals.screenshotUploadBatchSeconds',
    'intervals.heartbeatSeconds',
    'screenshots.averageImageSizesKB',
    'screenshots.viewsPerScreenshotScenarios',
    'recordings.liveViewPercentages',
    'meta.safetyMarginPct',
  ];
  for (const item of required) getValue(model, item, true);
}

function safeRate(model, dottedPath) {
  const raw = getValue(model, dottedPath, false);
  return raw == null ? null : Number(raw);
}

function computeUsage(model, employees, screenshotKB, viewsPerShot, livePct) {
  const workingDays = Number(getValue(model, 'workSchedule.workingDaysPerMonth'));
  const hoursPerDay = Number(getValue(model, 'workSchedule.workingHoursPerDay'));
  const captureSeconds = Number(getValue(model, 'intervals.screenshotCaptureSeconds'));
  const uploadBatchSeconds = Number(getValue(model, 'intervals.screenshotUploadBatchSeconds'));
  const heartbeatSeconds = Number(getValue(model, 'intervals.heartbeatSeconds'));
  const thumbnailFraction = Number(getValue(model, 'screenshots.thumbnailFractionOfImage'));
  const screenshotRowsPerShot = Number(getValue(model, 'databaseGrowth.screenshotRowsPerScreenshot'));
  const screenshotStatusWritesPerBatch = Number(getValue(model, 'databaseGrowth.screenshotStatusWritesPerBatch'));
  const heartbeatWritesPerHeartbeat = Number(getValue(model, 'databaseGrowth.heartbeatWritesPerHeartbeat'));
  const liveViewerHeartbeatSeconds = Number(getValue(model, 'intervals.viewerHeartbeatSeconds'));
  const recordingMbPerMinute = Number(getValue(model, 'recordings.estimatedRecordingUploadRatePerLiveMinute'));
  const blobLogBytes = Number(getValue(model, 'logs.estimatedBytesPerBlobUploadLogEvent'));
  const commitLogBytes = Number(getValue(model, 'logs.estimatedBytesPerScreenshotCommitLogEvent'));
  const safetyMarginPct = Number(getValue(model, 'meta.safetyMarginPct'));
  const retentionDays = Number(getValue(model, 'screenshots.retentionDays'));

  const workSecondsPerDay = hoursPerDay * 3600;
  const workMinutesPerDay = hoursPerDay * 60;
  const screenshotsPerEmployeePerDay = workSecondsPerDay / captureSeconds;
  const screenshotsPerEmployeePerMonth = screenshotsPerEmployeePerDay * workingDays;
  const totalScreenshotsPerMonth = screenshotsPerEmployeePerMonth * employees;
  const heartbeatPerEmployeePerDay = workSecondsPerDay / heartbeatSeconds;
  const heartbeatPerEmployeePerMonth = heartbeatPerEmployeePerDay * workingDays;
  const totalHeartbeatsPerMonth = heartbeatPerEmployeePerMonth * employees;
  const screenshotBatchesPerEmployeePerDay = workSecondsPerDay / uploadBatchSeconds;
  const screenshotCommitRequestsPerMonth = screenshotBatchesPerEmployeePerDay * workingDays * employees;
  const blobUploadTokenRequestsPerMonth = screenshotCommitRequestsPerMonth;
  const screenshotBytes = screenshotKB * 1024;
  const thumbnailBytes = screenshotBytes * thumbnailFraction;
  const screenshotUploadBytesMonthly = totalScreenshotsPerMonth * (screenshotBytes + thumbnailBytes);
  const screenshotDownloadBytesMonthly = totalScreenshotsPerMonth * viewsPerShot * screenshotBytes;
  const screenshotStorageSteadyStateBytes = (employees * screenshotsPerEmployeePerDay * retentionDays) * (screenshotBytes + thumbnailBytes);
  const dbScreenshotRowsPerMonth = totalScreenshotsPerMonth * screenshotRowsPerShot;
  const dbHeartbeatWritesPerMonth = totalHeartbeatsPerMonth * heartbeatWritesPerHeartbeat;
  const dbStatusWritesFromBatchesPerMonth = screenshotCommitRequestsPerMonth * screenshotStatusWritesPerBatch;
  const liveMinutesPerEmployeePerMonth = workMinutesPerDay * workingDays * livePct;
  const liveMinutesTotalMonthly = liveMinutesPerEmployeePerMonth * employees;
  const liveViewerHeartbeatsMonthly = liveMinutesTotalMonthly * (60 / liveViewerHeartbeatSeconds);
  const recordingUploadMBMonthly = liveMinutesTotalMonthly * recordingMbPerMinute;
  const logBytesMonthly = (blobUploadTokenRequestsPerMonth * blobLogBytes) + (screenshotCommitRequestsPerMonth * commitLogBytes);
  const baseApiRequestsMonthly = totalHeartbeatsPerMonth + screenshotCommitRequestsPerMonth + blobUploadTokenRequestsPerMonth + liveViewerHeartbeatsMonthly;
  const apiRequestsWithMargin = baseApiRequestsMonthly * (1 + safetyMarginPct / 100);

  return {
    formulas: {
      screenshotsPerEmployeePerDay: `${workSecondsPerDay} / ${captureSeconds}`,
      screenshotsPerEmployeePerMonth: `${screenshotsPerEmployeePerDay} * ${workingDays}`,
      totalScreenshotsPerMonth: `${screenshotsPerEmployeePerMonth} * ${employees}`,
      totalHeartbeatsPerMonth: `${heartbeatPerEmployeePerDay} * ${workingDays} * ${employees}`,
      screenshotUploadBytesMonthly: `${totalScreenshotsPerMonth} * (${screenshotBytes} + ${thumbnailBytes})`,
      screenshotDownloadBytesMonthly: `${totalScreenshotsPerMonth} * ${viewsPerShot} * ${screenshotBytes}`,
      screenshotStorageSteadyStateBytes: `${employees} * ${screenshotsPerEmployeePerDay} * ${retentionDays} * (${screenshotBytes} + ${thumbnailBytes})`,
      liveMinutesTotalMonthly: `${workMinutesPerDay} * ${workingDays} * ${livePct} * ${employees}`,
    },
    metrics: {
      employees,
      screenshotKB,
      viewsPerShot,
      livePct,
      heartbeatsPerEmployeePerDay: heartbeatPerEmployeePerDay,
      heartbeatsPerEmployeePerMonth: heartbeatPerEmployeePerMonth,
      screenshotsPerEmployeePerDay,
      screenshotsPerEmployeePerMonth,
      totalScreenshotsPerMonth,
      screenshotUploadGBMonthly: screenshotUploadBytesMonthly / (1024 ** 3),
      screenshotDownloadGBMonthly: screenshotDownloadBytesMonthly / (1024 ** 3),
      screenshotStorageGBSteadyState: screenshotStorageSteadyStateBytes / (1024 ** 3),
      databaseWritesMonthly: dbHeartbeatWritesPerMonth + dbStatusWritesFromBatchesPerMonth + dbScreenshotRowsPerMonth,
      screenshotRowsMonthly: dbScreenshotRowsPerMonth,
      activityRowsMonthly: 0,
      apiRequestsMonthly: baseApiRequestsMonthly,
      functionInvocationsMonthly: baseApiRequestsMonthly,
      liveStreamMinutesMonthly: liveMinutesTotalMonthly,
      estimatedRecordingUploadGBMonthly: recordingUploadMBMonthly / 1024,
      estimatedLogGBMonthly: logBytesMonthly / (1024 ** 3),
      screenshotCommitRequestsMonthly: screenshotCommitRequestsPerMonth,
      blobUploadTokenRequestsMonthly: blobUploadTokenRequestsPerMonth,
      liveViewerHeartbeatsMonthly,
      apiRequestsWithSafetyMargin: apiRequestsWithMargin,
    },
  };
}

function computeCosts(model, usage) {
  const screenshotStorage = usage.metrics.screenshotStorageGBSteadyState;
  const screenshotDownloads = usage.metrics.screenshotDownloadGBMonthly;
  const screenshotUploads = usage.metrics.screenshotUploadGBMonthly;
  const functionInvocations = usage.metrics.functionInvocationsMonthly;
  const safetyMult = 1 + Number(getValue(model, 'meta.safetyMarginPct')) / 100;

  const vercelBlobStoragePerGb = safeRate(model, 'providerPricing.currentArchitecture.vercelBlobStoragePerGBMonth');
  const vercelBlobTransferPerGb = safeRate(model, 'providerPricing.currentArchitecture.vercelBlobDataTransferPerGB');
  const vercelFnPerMillion = safeRate(model, 'providerPricing.currentArchitecture.vercelFunctionInvocationPerMillion');
  const neonMonthly = safeRate(model, 'providerPricing.currentArchitecture.neonPostgresMonthly');

  const storageCost = vercelBlobStoragePerGb == null ? null : screenshotStorage * vercelBlobStoragePerGb * safetyMult;
  const transferCost = vercelBlobTransferPerGb == null ? null : (screenshotDownloads + screenshotUploads) * vercelBlobTransferPerGb * safetyMult;
  const fnCost = vercelFnPerMillion == null ? null : (functionInvocations / 1000000) * vercelFnPerMillion * safetyMult;
  const fixedCost = neonMonthly;

  const total = [storageCost, transferCost, fnCost, fixedCost].some((v) => v == null)
    ? null
    : storageCost + transferCost + fnCost + fixedCost;

  return {
    fixedCost,
    variableCosts: {
      blobStorage: storageCost,
      blobTransfer: transferCost,
      functionInvocations: fnCost,
    },
    total,
    costPerEmployee: total == null ? null : total / usage.metrics.employees,
  };
}

function main() {
  const modelPath = path.join(process.cwd(), 'docs', 'cost-model.json');
  const model = readJson(modelPath);
  validateModel(model);

  printSection('Model Validation');
  console.log(`Loaded ${modelPath}`);
  console.log('Validation: OK');

  const employeeScenarios = getValue(model, 'employeeScenarios.counts');
  const screenshotSizes = getValue(model, 'screenshots.averageImageSizesKB');
  const viewScenarios = getValue(model, 'screenshots.viewsPerScreenshotScenarios');
  const livePercentages = getValue(model, 'recordings.liveViewPercentages');

  printSection('Provider Pricing Status');
  console.log(`Current architecture blob storage: ${formatMaybeMoney(safeRate(model, 'providerPricing.currentArchitecture.vercelBlobStoragePerGBMonth'))}`);
  console.log(`Current architecture blob transfer: ${formatMaybeMoney(safeRate(model, 'providerPricing.currentArchitecture.vercelBlobDataTransferPerGB'))}`);
  console.log(`Current architecture function invocations: ${formatMaybeMoney(safeRate(model, 'providerPricing.currentArchitecture.vercelFunctionInvocationPerMillion'))}`);
  console.log(`Current architecture database fixed monthly: ${formatMaybeMoney(safeRate(model, 'providerPricing.currentArchitecture.neonPostgresMonthly'))}`);

  for (const employees of employeeScenarios) {
    const usage = computeUsage(model, employees, screenshotSizes[1], viewScenarios[1], livePercentages[1]);
    const costs = computeCosts(model, usage);

    printSection(`Scenario ${employees} Employees`);
    console.log(`Formula screenshots/employee/day = ${usage.formulas.screenshotsPerEmployeePerDay}`);
    console.log(`Formula total screenshots/month = ${usage.formulas.totalScreenshotsPerMonth}`);
    console.log(`Formula upload GB/month = ${usage.formulas.screenshotUploadBytesMonthly}`);
    console.log(`Formula live minutes/month = ${usage.formulas.liveMinutesTotalMonthly}`);
    console.log(`Heartbeats/employee/day: ${formatNumber(usage.metrics.heartbeatsPerEmployeePerDay)}`);
    console.log(`Heartbeats/employee/month: ${formatNumber(usage.metrics.heartbeatsPerEmployeePerMonth)}`);
    console.log(`Screenshots/employee/day: ${formatNumber(usage.metrics.screenshotsPerEmployeePerDay)}`);
    console.log(`Screenshots/employee/month: ${formatNumber(usage.metrics.screenshotsPerEmployeePerMonth)}`);
    console.log(`Total screenshots/month: ${formatNumber(usage.metrics.totalScreenshotsPerMonth, 0)}`);
    console.log(`Screenshot upload GB/month: ${formatNumber(usage.metrics.screenshotUploadGBMonthly)}`);
    console.log(`Screenshot download GB/month: ${formatNumber(usage.metrics.screenshotDownloadGBMonthly)}`);
    console.log(`Steady-state screenshot storage GB: ${formatNumber(usage.metrics.screenshotStorageGBSteadyState)}`);
    console.log(`Database writes/month: ${formatNumber(usage.metrics.databaseWritesMonthly, 0)}`);
    console.log(`API requests/month: ${formatNumber(usage.metrics.apiRequestsMonthly, 0)}`);
    console.log(`Function invocations/month: ${formatNumber(usage.metrics.functionInvocationsMonthly, 0)}`);
    console.log(`Live stream minutes/month: ${formatNumber(usage.metrics.liveStreamMinutesMonthly)}`);
    console.log(`Estimated recording upload GB/month: ${formatNumber(usage.metrics.estimatedRecordingUploadGBMonthly)}`);
    console.log(`Estimated log GB/month: ${formatNumber(usage.metrics.estimatedLogGBMonthly)}`);
    console.log(`Fixed monthly cost: ${formatMaybeMoney(costs.fixedCost)}`);
    console.log(`Variable monthly cost: ${formatMaybeMoney(
      [costs.variableCosts.blobStorage, costs.variableCosts.blobTransfer, costs.variableCosts.functionInvocations].some((v) => v == null)
        ? null
        : costs.variableCosts.blobStorage + costs.variableCosts.blobTransfer + costs.variableCosts.functionInvocations
    )}`);
    console.log(`Total monthly cost: ${formatMaybeMoney(costs.total)}`);
    console.log(`Cost per employee: ${formatMaybeMoney(costs.costPerEmployee)}`);
  }

  printSection('Sensitivity Matrix');
  for (const screenshotKB of screenshotSizes) {
    for (const viewsPerShot of viewScenarios) {
      for (const livePct of livePercentages) {
        const usage = computeUsage(model, employeeScenarios[0], screenshotKB, viewsPerShot, livePct);
        console.log(
          `employees=${employeeScenarios[0]}, screenshotKB=${screenshotKB}, views=${viewsPerShot}, livePct=${livePct}: ` +
          `uploadGB=${formatNumber(usage.metrics.screenshotUploadGBMonthly)}, ` +
          `downloadGB=${formatNumber(usage.metrics.screenshotDownloadGBMonthly)}, ` +
          `liveMinutes=${formatNumber(usage.metrics.liveStreamMinutesMonthly)}`
        );
      }
    }
  }
}

main();
