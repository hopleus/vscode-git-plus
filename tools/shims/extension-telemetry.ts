export default class TelemetryReporter {
	constructor(_connectionString?: string) { }

	sendTelemetryEvent(_name: string, _properties?: unknown, _measurements?: unknown): void { }

	sendTelemetryErrorEvent(_name: string, _properties?: unknown, _measurements?: unknown): void { }

	dispose(): Promise<void> {
		return Promise.resolve();
	}
}
