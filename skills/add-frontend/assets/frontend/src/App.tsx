import { Streams, useDaiConnection } from '@luxonis/depthai-viewer-common';
import { Badge, Flex, PageTitle } from '@luxonis/ui-components';
import { Controls } from './Controls.tsx';
import { STREAMS } from './streams.ts';

const TITLE = '__APP_TITLE__';

export default function App() {
	const { connected } = useDaiConnection();

	return (
		<div className="app-page">
			<Flex direction="row" align="center" justify="between" gap="md">
				<PageTitle text={TITLE} />
				<Badge
					dot
					intent={connected ? 'success' : 'gray'}
					label={connected ? 'Connected' : 'Connecting'}
				/>
			</Flex>
			<div className="app-main">
				<div className="app-streams">
					<Streams hideToolbar defaultTopics={STREAMS} />
				</div>
				<div className="app-side">
					<Controls />
				</div>
			</div>
		</div>
	);
}
