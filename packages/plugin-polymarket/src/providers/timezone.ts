/**
 * Timezone Provider
 *
 * Provides real-time date/timezone context for the agent.
 * Uses US Eastern Time as the primary timezone.
 * Critical for understanding market expiration and current events.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '@elizaos/core';

/**
 * Get current date/time in US Eastern timezone
 */
export function getCurrentETTime(): {
  date: Date;
  dateStr: string;
  timeStr: string;
  timezone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  dayOfWeek: string;
  isWeekend: boolean;
  isMarketHours: boolean;
  isoString: string;
} {
  const now = new Date();

  // Format for US Eastern Time
  const etOptions: Intl.DateTimeFormatOptions = {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
  };

  const etFormatter = new Intl.DateTimeFormat('en-US', etOptions);
  const parts = etFormatter.formatToParts(now);

  const getPart = (type: string): string =>
    parts.find((p) => p.type === type)?.value || '';

  const year = parseInt(getPart('year'));
  const month = parseInt(getPart('month'));
  const day = parseInt(getPart('day'));
  const hour = parseInt(getPart('hour'));
  const minute = getPart('minute');
  const second = getPart('second');
  const dayOfWeek = getPart('weekday');

  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timeStr = `${String(hour).padStart(2, '0')}:${minute}:${second}`;

  const isWeekend = dayOfWeek === 'Saturday' || dayOfWeek === 'Sunday';
  // Traditional market hours: 9:30 AM - 4:00 PM ET
  const isMarketHours = !isWeekend && hour >= 9 && hour < 16;

  return {
    date: now,
    dateStr,
    timeStr,
    timezone: 'America/New_York (Eastern Time)',
    year,
    month,
    day,
    hour,
    dayOfWeek,
    isWeekend,
    isMarketHours,
    isoString: now.toISOString(),
  };
}

/**
 * Check if a date string represents an expired market
 */
export function isMarketExpired(endDateStr: string | undefined): boolean {
  if (!endDateStr) return false;

  try {
    const endDate = new Date(endDateStr);
    const now = new Date();
    return endDate < now;
  } catch {
    return false;
  }
}

/**
 * Check if a market is likely from a past year (e.g., "2025" in question when current year is 2026)
 * Only filters if the market ONLY mentions past years (not if it also mentions current/future years)
 */
export function detectPastYearMarket(
  question: string,
  currentYear: number
): { isPast: boolean; mentionedYear?: number } {
  // Look for year patterns like "2025", "in 2024", "by 2025", etc.
  const yearPattern = /\b(20\d{2})\b/g;
  const matches = question.match(yearPattern);

  if (!matches) return { isPast: false };

  // Get unique years mentioned
  const uniqueYears = [...new Set(matches.map(y => parseInt(y)))];

  // Check if ANY year is current or future - if so, market is still valid
  const hasCurrentOrFutureYear = uniqueYears.some(year => year >= currentYear);
  if (hasCurrentOrFutureYear) {
    return { isPast: false };
  }

  // All mentioned years are in the past - this market is likely resolved
  const maxPastYear = Math.max(...uniqueYears);
  return { isPast: true, mentionedYear: maxPastYear };
}

/**
 * Get relative time description
 */
export function getRelativeTimeContext(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;

  if (diffMs < 0) {
    const pastHours = Math.abs(diffHours);
    if (pastHours < 1) return 'just ended';
    if (pastHours < 24) return `ended ${Math.round(pastHours)} hours ago`;
    if (pastHours < 48) return 'ended yesterday';
    return `ended ${Math.round(Math.abs(diffDays))} days ago`;
  }

  if (diffHours < 1) return 'ending soon (< 1 hour)';
  if (diffHours < 24) return `ends in ${Math.round(diffHours)} hours`;
  if (diffDays < 2) return 'ends tomorrow';
  if (diffDays < 7) return `ends in ${Math.round(diffDays)} days`;
  if (diffDays < 30) return `ends in ${Math.round(diffDays / 7)} weeks`;
  if (diffDays < 365) return `ends in ${Math.round(diffDays / 30)} months`;
  return `ends in ${Math.round(diffDays / 365)} years`;
}

export const timezoneProvider: Provider = {
  name: 'TIMEZONE_CONTEXT',
  description: 'Provides current date, time, and timezone context (US Eastern Time)',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    try {
      const et = getCurrentETTime();

      const contextText = `
**Current Date/Time Context:**
- Date: ${et.dayOfWeek}, ${et.dateStr}
- Time: ${et.timeStr} ET (Eastern Time)
- Year: ${et.year}
- Market Hours: ${et.isMarketHours ? 'Open (9:30 AM - 4:00 PM ET)' : 'Closed'}
- Weekend: ${et.isWeekend ? 'Yes' : 'No'}

**Important Date Awareness:**
- Current year is ${et.year}. Markets referencing years before ${et.year} have likely already resolved.
- Markets with end dates before ${et.dateStr} have expired.
- Consider timezone when evaluating deadlines and events.
`.trim();

      return {
        text: contextText,
        values: {
          currentYear: et.year,
          currentMonth: et.month,
          currentDay: et.day,
          currentHour: et.hour,
          currentDateStr: et.dateStr,
          currentTimeStr: et.timeStr,
          timezone: 'America/New_York',
          isWeekend: et.isWeekend,
          isMarketHours: et.isMarketHours,
        },
        data: {
          timezone: et,
        },
      };
    } catch (error) {
      logger.error({ error }, '[TimezoneProvider] Error getting timezone');
      return {
        text: '',
        values: {},
        data: {},
      };
    }
  },
};
