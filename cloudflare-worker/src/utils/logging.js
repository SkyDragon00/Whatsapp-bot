export function logEvent(level, event, context = {}) {
	const output = JSON.stringify({ ...context, level, event });
	if (level === 'error') console.error(output);
	else console.log(output);
}

export function logError(event, error, context = {}) {
	logEvent('error', event, {
		...context,
			errorName: error instanceof Error ? error.name : 'UnknownError',
			errorCode: typeof error?.code === 'string' ? error.code : undefined,
			errorStatus: Number.isInteger(error?.status) ? error.status : undefined,
	});
}
