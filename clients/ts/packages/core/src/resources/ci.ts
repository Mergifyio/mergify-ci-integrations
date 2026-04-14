import type { Attributes } from '@opentelemetry/api';
import { getCIProvider } from '../utils.js';

export function detect(): Attributes {
  const provider = getCIProvider();
  if (!provider) return {};
  return { 'cicd.provider.name': provider };
}
