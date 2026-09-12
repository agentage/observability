'use client';

import { useEffect, useRef } from 'react';
import { observeBrowser, type ObserveBrowserOptions } from './browser.js';

export type { ObserveBrowserOptions };

/**
 * Drop-in client component for a React app: mount it once in the root layout and
 * the browser lane is wired - error reporting plus one trace id per user action.
 * Renders nothing, and re-installs only when the reporter's identity changes.
 *
 * ```tsx
 * <ErrorReporter endpoint="/api/client-errors" service="dashboard" userId={user?.id} />
 * ```
 */
export function ErrorReporter(options: ObserveBrowserOptions): null {
  const { endpoint, service, userId, propagate } = options;
  // A fresh options object every render must not tear the reporter down.
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => observeBrowser(latest.current), [endpoint, service, userId, propagate]);
  return null;
}
