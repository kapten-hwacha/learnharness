import { useCallback, useRef, useState } from "react";
import type { AbortMode } from "@/components/abort-turn-dialog";

export type { AbortMode };

export interface UseChatAbortDialogOptions {
	onConfirmAbort: (mode: AbortMode) => void;
}

export function useChatAbortDialog(options: UseChatAbortDialogOptions) {
	const [abortAsk, setAbortAsk] = useState<AbortMode | null>(null);
	const abortAskRef = useRef<AbortMode | null>(null);
	abortAskRef.current = abortAsk;

	const confirmAbort = useCallback(
		(mode: AbortMode) => {
			setAbortAsk(null);
			options.onConfirmAbort(mode);
		},
		[options],
	);

	const cancelAbort = useCallback(() => {
		setAbortAsk(null);
	}, []);

	return {
		abortAsk,
		setAbortAsk,
		abortAskRef,
		confirmAbort,
		cancelAbort,
	};
}
