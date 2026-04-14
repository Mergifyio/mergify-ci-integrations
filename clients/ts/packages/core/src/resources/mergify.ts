import type { Attributes } from '@opentelemetry/api';

export function detect(): Attributes {
  const jobName = process.env.MERGIFY_TEST_JOB_NAME;
  if (jobName) return { 'mergify.test.job.name': jobName };
  return {};
}
