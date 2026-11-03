import { useDaiConnection } from '@luxonis/depthai-viewer-common';
import { useCallback } from 'react';

export const SERVICES = {} as const satisfies Record<string, string>;

export type ServiceName = (typeof SERVICES)[keyof typeof SERVICES];

type DaiConnection = NonNullable<
	ReturnType<typeof useDaiConnection>['daiConnection']
>;
type LibraryServiceName = Parameters<DaiConnection['postToService']>[0];
type ServiceBody = Parameters<DaiConnection['postToService']>[1];

/**
 * Returns a function that calls a Python service. It resolves with the value the Python handler returned,
 * and rejects when the handler returns a dict whose "error" is set.
 */
export function useService() {
	const { daiConnection } = useDaiConnection();
	return useCallback(
		<T = unknown>(name: ServiceName, body: ServiceBody = {}) =>
			new Promise<T>((resolve, reject) => {
				if (!daiConnection) {
					reject(new Error('Not connected to the app.'));
					return;
				}
				daiConnection
					.postToService(
						// The library types only its built-in services; the app registers its own names.
						name as LibraryServiceName,
						body,
						// The library types responses as an envelope, but passes back the handler's value as is.
						(response) => resolve(response as unknown as T),
						(response) =>
							reject(new Error(String(response?.error ?? `${name} failed.`))),
					)
					.catch(reject);
			}),
		[daiConnection],
	);
}
