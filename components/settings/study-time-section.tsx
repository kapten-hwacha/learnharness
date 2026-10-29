"use client";

/**
 * The "Study time" settings section (design: docs/designs/study-time.md):
 * the idle limit, teach session soft cap, and the first day of the week.
 * Replace-whole section PUTs through the dialog's single writer, like GraphSection.
 */
import {
	STUDY_IDLE_MINUTES_MAX,
	STUDY_IDLE_MINUTES_MIN,
	STUDY_SOFT_CAP_MINUTES_MAX,
	STUDY_SOFT_CAP_MINUTES_MIN,
	type StudyTimeSettings,
} from "@/src/core";
import { CommitInput, SettingsRow, ThinSelect } from "./controls.tsx";

const SOFT_CAP_MIN = STUDY_SOFT_CAP_MINUTES_MIN ?? 0;
const SOFT_CAP_MAX = STUDY_SOFT_CAP_MINUTES_MAX ?? 180;

export function StudyTimeSection({
	studyTime,
	resolved,
	onSectionChange,
}: {
	studyTime: StudyTimeSettings | undefined;
	resolved: Required<StudyTimeSettings>;
	onSectionChange: (next: StudyTimeSettings) => void;
}) {
	return (
		<>
			<SettingsRow label="Idle limit (minutes)" hint={`${resolved.idleMinutes} min`} testid="study-row-idle">
				<CommitInput
					type="number"
					value={String(studyTime?.idleMinutes ?? "")}
					placeholder={String(resolved.idleMinutes)}
					ariaLabel="idle limit in minutes"
					testid="input-study-idle"
					onCommit={(v) => {
						// Empty = factory default (absence is the unset for numbers).
						if (v === "") {
							onSectionChange({ ...studyTime, idleMinutes: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write
						onSectionChange({
							...studyTime,
							idleMinutes: Math.min(STUDY_IDLE_MINUTES_MAX, Math.max(STUDY_IDLE_MINUTES_MIN, Math.round(n))),
						});
					}}
				/>
			</SettingsRow>
			<SettingsRow
				label="Teach session soft cap (minutes)"
				hint={resolved.teachSoftCapMinutes === 0 ? "Off" : `${resolved.teachSoftCapMinutes} min`}
				testid="study-row-soft-cap"
			>
				<CommitInput
					type="number"
					value={String(studyTime?.teachSoftCapMinutes ?? "")}
					placeholder={String(resolved.teachSoftCapMinutes ?? 20)}
					ariaLabel="teach session soft cap in minutes"
					testid="input-study-soft-cap"
					onCommit={(v) => {
						if (v === "") {
							onSectionChange({ ...studyTime, teachSoftCapMinutes: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...studyTime,
							teachSoftCapMinutes: Math.min(SOFT_CAP_MAX, Math.max(SOFT_CAP_MIN, Math.round(n))),
						});
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Week starts on" testid="study-row-week-start">
				<ThinSelect
					value={studyTime?.weekStart ?? resolved.weekStart}
					ariaLabel="week starts on"
					testid="select-study-week-start"
					onChange={(next) => onSectionChange({ ...studyTime, weekStart: next === "sunday" ? "sunday" : "monday" })}
				>
					<option value="monday">Monday</option>
					<option value="sunday">Sunday</option>
				</ThinSelect>
			</SettingsRow>
		</>
	);
}
