"use client";

import { SettingsRow } from "./controls.tsx";

/** Version information is displayed in Settings -> General. */
export function UpdateSettings({
	version = process.env.LH_VERSION ?? "",
	homepage = process.env.LH_HOMEPAGE ?? "",
}: {
	version?: string;
	homepage?: string;
} = {}) {
	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;

	return (
		<SettingsRow
			label={`Version ${version || "unknown"}`}
			testid="row-version"
			hint={
				releaseNotes ? (
					<a
						href={releaseNotes}
						target="_blank"
						rel="noopener noreferrer"
						className="underline-offset-2 hover:text-foreground hover:underline"
						data-testid="release-notes"
					>
						Release notes
					</a>
				) : null
			}
		>
			{null}
		</SettingsRow>
	);
}
