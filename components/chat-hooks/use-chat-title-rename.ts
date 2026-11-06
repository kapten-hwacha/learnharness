import { useCallback, useEffect, useRef, useState } from "react";

export interface UseChatTitleRenameOptions {
	chatId: string;
	title: string;
	onRenamed?: (newTitle: string) => void;
}

export function useChatTitleRename({ chatId, title, onRenamed }: UseChatTitleRenameOptions) {
	const [titleText, setTitleText] = useState(title);
	const [renaming, setRenaming] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const titleInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		setTitleText(title);
	}, [title]);

	const startRename = useCallback(() => {
		setTitleDraft(titleText);
		setRenaming(true);
	}, [titleText]);

	const cancelRename = useCallback(() => {
		setRenaming(false);
	}, []);

	const commitRename = useCallback(
		async (next: string) => {
			setRenaming(false);
			const t = next.trim();
			if (t === "" || t === titleText) return;
			try {
				const res = await fetch(`/api/chats/${chatId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: t }),
				});
				if (!res.ok) throw new Error(`rename failed: ${res.status}`);
				setTitleText(t);
				onRenamed?.(t);
				window.dispatchEvent(
					new CustomEvent("lh:chat-renamed", { detail: { id: chatId, title: t } }),
				);
			} catch (err) {
				console.error("rename failed:", err);
			}
		},
		[chatId, titleText, onRenamed],
	);

	useEffect(() => {
		if (renaming) {
			const el = titleInputRef.current;
			if (el) {
				el.focus();
				el.select();
			}
		}
	}, [renaming]);

	useEffect(() => {
		const onRename = () => {
			setTitleDraft(titleText);
			setRenaming(true);
		};
		window.addEventListener("lh:kbd-rename-session", onRename);
		return () => window.removeEventListener("lh:kbd-rename-session", onRename);
	}, [titleText]);

	useEffect(() => {
		const onExternalRenamed = (e: Event) => {
			const { id, title: newTitle } = (e as CustomEvent<{ id: string; title: string }>).detail;
			if (id === chatId) setTitleText((prev) => (newTitle !== prev ? newTitle : prev));
		};
		window.addEventListener("lh:chat-renamed", onExternalRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onExternalRenamed);
	}, [chatId]);

	return {
		titleText,
		setTitleText,
		renaming,
		setRenaming,
		titleDraft,
		setTitleDraft,
		titleInputRef,
		startRename,
		cancelRename,
		commitRename,
	};
}
