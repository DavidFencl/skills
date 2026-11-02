# The frontend

The template in `assets/frontend/` is a Vite, React 19 and Tailwind 4 app, built like the custom frontends in `luxonis/oak-examples`.

| File | What it does |
| --- | --- |
| `src/main.tsx` | Mounts `DepthAIContext`, which opens the connection to the app, and the router. Hub serves the app under `/<version>/`, so the router's base path comes from the URL. |
| `src/App.tsx` | The page: a title, the connection badge, the streams, and a side column with the controls and any panels. |
| `src/streams.ts` | `STREAMS`, the topics the page opens when it connects. |
| `src/services.ts` | `SERVICES`, the Python service names, and `useService()`, which calls them. |
| `src/Controls.tsx` | The controls card. You fill it. |
| `src/index.css` | Tailwind, plus the page layout (`app-page`, `app-main`, `app-streams`, `app-side`) in plain CSS. |
| `vite.config.ts` | `base: ''` for relative paths, ES module workers for the stream decoder, a build limit for the device, and a fix for a package that imports its own `package.json`. Leave it as it is. |
| `package-lock.json` | The lockfile of the oak-examples template. `npm ci` installs it as it is. Run `npm install` only to change a version, because it rewrites the lockfile. |

## The connection

`useDaiConnection()` returns the connection state. `connected` is true once the page talks to the app, and `daiConnection` is the connection itself.

The page finds the app's WebSocket in this order:
1. `?ws_url=<url>` in the page URL.
2. On `localhost`, `ws://localhost:8765`.
3. When the page comes from port 8082, `ws://<same host>:8765`.
4. Otherwise, `wss://<same host and port>/dai`. That is the standalone case, where the device's web server forwards `/dai`.

A page served from any other port, opened from another computer, needs `?ws_url=`. Keep port 8082.

## Streams

`<Streams hideToolbar defaultTopics={STREAMS} />` shows the app's topics. With the toolbar hidden, the user cannot pick a stream, so the page opens exactly the topics in `STREAMS`, by the names the app passed to `addTopic`. Over a WebSocket, the viewer opens no other topic by itself. Encoded streams play only in Chrome.

## Services

The Python handler gets the value that the page sends, and returns a JSON-serializable value:

```python
def set_threshold(body):
    threshold = float(body["threshold"])
    detection_network.setConfidenceThreshold(threshold)
    return {"threshold": threshold}

visualizer.registerService("Set Threshold", set_threshold)
```

On the page, name the service in `SERVICES`, and call it with `useService()`:

```ts
export const SERVICES = { setThreshold: 'Set Threshold' } as const satisfies Record<string, string>;
```

```tsx
const call = useService();
const result = await call<{ threshold: number }>(SERVICES.setThreshold, { threshold: 0.5 });
```

The promise resolves with what the handler returned. It rejects when the handler returns `{"error": "<message>"}`, when the app is not connected, and after 60 seconds without an answer.

## Control patterns

Each control keeps its own value in React state, calls its service when the user changes the value, and shows a failure under itself. Put them in `Controls.tsx`:

```tsx
import { useDaiConnection } from '@luxonis/depthai-viewer-common';
import {
	Button,
	Card,
	Flex,
	Input,
	Label,
	Select,
	Slider,
	SubLabel,
	Switch,
} from '@luxonis/ui-components';
import { useEffect, useState } from 'react';
import { SERVICES, useService } from './services.ts';

export function Controls() {
	const call = useService();
	const { connected } = useDaiConnection();
	const [error, setError] = useState<string | null>(null);
	const send = (
		name: (typeof SERVICES)[keyof typeof SERVICES],
		body: Record<string, unknown> = {},
	) =>
		call(name, body).then(
			() => setError(null),
			(failure: Error) => setError(failure.message),
		);

	const [threshold, setThreshold] = useState(0.5);
	const [tracking, setTracking] = useState(false);
	const [model, setModel] = useState('yolo');
	const [prompt, setPrompt] = useState('');

	// Read the app's current values once connected, so the controls start where the app is.
	useEffect(() => {
		if (!connected) return;
		call<{ threshold: number; tracking: boolean }>(SERVICES.getSettings).then(
			(settings) => {
				setThreshold(settings.threshold);
				setTracking(settings.tracking);
			},
			(failure: Error) => setError(failure.message),
		);
	}, [connected, call]);

	return (
		<Card title="Controls" variant="outline" intent="gray">
			<Flex direction="column" gap="md">
				<Button onClick={() => send(SERVICES.capture)}>Capture</Button>

				<Switch
					value={tracking}
					enabledLabel="Tracking on"
					disabledLabel="Tracking off"
					onChange={(next) => {
						setTracking(next);
						send(SERVICES.setTracking, { enabled: next });
					}}
				/>

				<Flex direction="column" gap="xs">
					<Label text={`Confidence ${threshold.toFixed(2)}`} />
					<Slider
						value={threshold}
						min={0}
						max={1}
						step={0.05}
						onChange={setThreshold}
						onValueCommit={([value]) =>
							send(SERVICES.setThreshold, { threshold: value })
						}
					/>
				</Flex>

				<Select
					items={[
						{ value: 'yolo', component: 'YOLO' },
						{ value: 'ssd', component: 'SSD' },
					]}
					value={model}
					onChange={(next) => {
						setModel(next);
						send(SERVICES.setModel, { model: next });
					}}
				/>

				<Flex direction="row" gap="sm">
					<Input
						value={prompt}
						placeholder="Prompt"
						onChange={(event) => setPrompt(event.target.value)}
					/>
					<Button onClick={() => send(SERVICES.setPrompt, { prompt })}>
						Send
					</Button>
				</Flex>

				{error && <SubLabel color="error" text={error} />}
			</Flex>
		</Card>
	);
}
```

The slider calls its service once, when the user releases it (`onValueCommit`), not on every step.

## Styling

- Build every control and every piece of text from `@luxonis/ui-components`: `Button`, `Switch`, `Slider`, `Select`, `Input`, `Card`, `Flex`, `PageTitle`, `Label`, `SubLabel`, `Badge` and `Alert`.
- Use Tailwind classes only for layout and sizing, such as `flex-1` and `gap-4`. Colors and type come from the components and their `--lux-*` variables. Never write a hex color.
- Write layout that changes with the screen width as plain CSS in `src/index.css`, under a class name that starts with `app-`. The Luxonis libraries load their own copies of Tailwind's utilities after the app's, so a class such as `md:flex-row` loses to their `.flex-col`.
- Use relative paths for images and other files, such as `./logo.svg`.
