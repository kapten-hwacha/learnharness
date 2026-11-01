import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	CLIPROXY_DEFAULT_KEY,
	CLIPROXY_DEFAULT_URL,
	CLIPROXY_LABEL,
	CLIPROXY_PROVIDER,
} from "../../core/contracts/cliproxy.ts";

export const CLIPROXY_MODELS: readonly Model<Api>[] = [
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		api: "openai-completions",
		provider: CLIPROXY_PROVIDER,
		baseUrl: CLIPROXY_DEFAULT_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		api: "openai-completions",
		provider: CLIPROXY_PROVIDER,
		baseUrl: CLIPROXY_DEFAULT_URL,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

export function createCliProxyProvider(): Provider<Api> {
	return createProvider<Api>({
		id: CLIPROXY_PROVIDER,
		name: CLIPROXY_LABEL,
		baseUrl: CLIPROXY_DEFAULT_URL,
		auth: {
			apiKey: {
				name: `${CLIPROXY_LABEL} API key`,
				resolve: async () => ({
					auth: { apiKey: CLIPROXY_DEFAULT_KEY },
					source: "local-cliproxy",
				}),
			},
		},
		models: CLIPROXY_MODELS as Model<Api>[],
		api: openAICompletionsApi(),
	});
}
