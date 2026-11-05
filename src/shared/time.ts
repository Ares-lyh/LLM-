import { Temporal } from '@js-temporal/polyfill';

export function melbourneLocalToInstant(value: string): string {
  return Temporal.PlainDateTime.from(value)
    .toZonedDateTime('Australia/Melbourne', { disambiguation: 'reject' })
    .toInstant().toString();
}
