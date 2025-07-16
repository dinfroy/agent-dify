import { headers } from "next/headers";
import { z } from "zod";
import { zfd } from "zod-form-data";
import { WebSocket } from "ws";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";

const schema = zfd.formData({
	input: z.union([zfd.text(), zfd.file()]),
	message: zfd.repeatableOfType(
		zfd.json(
			z.object({
				role: z.enum(["user", "assistant"]),
				content: z.string(),
			})
		)
	),
});

export async function POST(request: Request) {
	console.time("transcribe " + request.headers.get("x-vercel-id") || "local");

	const { data, success } = schema.safeParse(await request.formData());
	if (!success) return new Response("Invalid request", { status: 400 });

	// --- TRANSCRIPCIÓN ---
	const transcript = await getTranscript(data.input);
	if (!transcript) return new Response("Invalid audio", { status: 400 });

	console.timeEnd(
		"transcribe " + request.headers.get("x-vercel-id") || "local"
	);
	console.time(
		"text completion " + request.headers.get("x-vercel-id") || "local"
	);

	// --- RESPUESTA CON DIFY ---
	const DIFY_API_KEY = process.env.DIFY_API_KEY;
	if (!DIFY_API_KEY) return new Response("DIFY_API_KEY not set", { status: 500 });

	let responseText = "";
	let conversationId = "";

	const difyRes = await fetch("https://api.dify.ai/v1/chat-messages", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${DIFY_API_KEY}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			query: transcript,
			inputs: {},
			response_mode: "streaming",
			user: "vozai-user",
			conversation_id: ""
		})
	});

	if (!difyRes.body) return new Response("No response from Dify", { status: 500 });

	const reader = difyRes.body.getReader();
	let done = false;
	let decoder = new TextDecoder();

	while (!done) {
		const { value, done: doneReading } = await reader.read();
		done = doneReading;
		if (value) {
			const chunk = decoder.decode(value, { stream: true });
			// Procesar cada línea SSE
			for (const line of chunk.split("\n\n")) { // SSE usa doble newline
				if (line.startsWith("data:")) {
					try {
						const eventData = line.slice(5).trim();
						if (eventData) {
							const event = JSON.parse(eventData);
							if (event.event === "message" && event.answer) {
								responseText += event.answer;
								conversationId = event.conversation_id || conversationId;
							}
							if (event.event === "message_end") {
								done = true;
								break; // Salir del for loop
							}
						}
					} catch {}
				}
			}
		}
	}

	console.timeEnd(
		"text completion " + request.headers.get("x-vercel-id") || "local"
	);

	if (!responseText) return new Response("Invalid response", { status: 500 });

	// --- INTEGRACIÓN FISH AUDIO ---
	const FISH_AUDIO_API_KEY = process.env.FISH_AUDIO_API_KEY;
	const FISH_AUDIO_MODEL = process.env.FISH_AUDIO_MODEL || "s1";
	const FISH_AUDIO_ID_REFERENCIA = process.env.FISH_AUDIO_ID_REFERENCIA || undefined;
	const FISH_AUDIO_SAMPLE_RATE = 24000;
	const FISH_AUDIO_FORMAT = "pcm";
	const FISH_AUDIO_TIMEOUT = 20000; // 20 segundos

	if (!FISH_AUDIO_API_KEY) {
		return new Response("FISH_AUDIO_API_KEY not set", { status: 500 });
	}

	let ws: WebSocket | null = null;
	let timeout: NodeJS.Timeout | null = null;

	const stream = new ReadableStream({
		start(controller) {
			let finished = false;

			function cleanup() {
				if (ws) ws.close();
				if (timeout) clearTimeout(timeout);
				finished = true;
			}

			ws = new WebSocket("wss://api.fish.audio/v1/tts/live", {
				headers: {
					Authorization: `Bearer ${FISH_AUDIO_API_KEY}`,
					model: FISH_AUDIO_MODEL,
				},
			});

			ws.binaryType = "arraybuffer";

			ws.onopen = () => {
				if (!ws) return;
				// Enviar evento start
				const startPayload: any = {
					event: "start",
					request: {
						text: "",
						latency: "normal",
						format: FISH_AUDIO_FORMAT,
						sample_rate: FISH_AUDIO_SAMPLE_RATE,
						model: FISH_AUDIO_MODEL,
						id_referencia: FISH_AUDIO_ID_REFERENCIA,
					},
				};
				ws.send(msgpackEncode(startPayload));
				// Enviar el texto completo como un solo chunk
				ws.send(msgpackEncode({ event: "text", text: responseText + " " }));
				// Forzar flush para baja latencia
				ws.send(msgpackEncode({ event: "flush" }));
				// Timeout de seguridad
				timeout = setTimeout(() => {
					cleanup();
					controller.error("Fish Audio timeout");
				}, FISH_AUDIO_TIMEOUT);
			};

			ws.onmessage = (event) => {
				try {
					const buffer = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array();
					const data = msgpackDecode(buffer) as any;
					if (data && data.event === "audio" && data.audio) {
						let audioChunk: Uint8Array;
						if (typeof data.audio === "string") {
							// Si viene como base64
							const bin = atob(data.audio);
							audioChunk = new Uint8Array(bin.length);
							for (let i = 0; i < bin.length; i++) audioChunk[i] = bin.charCodeAt(i);
						} else if (Array.isArray(data.audio)) {
							audioChunk = new Uint8Array(data.audio);
						} else {
							audioChunk = new Uint8Array();
						}
						controller.enqueue(audioChunk);
					}
					if (data && (data.event === "finish" || data.event === "stop")) {
						cleanup();
						controller.close();
					}
				} catch (err) {
					cleanup();
					controller.error("Fish Audio decode error");
				}
			};

			ws.onerror = (err) => {
				cleanup();
				controller.error("Fish Audio WebSocket error");
			};

			ws.onclose = () => {
				if (!finished) {
					controller.close();
				}
			};
		},
		cancel() {
			if (ws) ws.close();
			if (timeout) clearTimeout(timeout);
		},
	});

	// --- FIN INTEGRACIÓN FISH AUDIO ---

	return new Response(stream, {
		headers: {
			"X-Transcript": encodeURIComponent(transcript),
			"X-Response": encodeURIComponent(responseText),
			"X-Conversation-Id": conversationId,
		},
	});
}

async function location() {
	const headersList = await headers();

	const country = headersList.get("x-vercel-ip-country");
	const region = headersList.get("x-vercel-ip-country-region");
	const city = headersList.get("x-vercel-ip-city");

	if (!country || !region || !city) return "unknown";

	return `${city}, ${region}, ${country}`;
}

async function time() {
	const headersList = await headers();
	const timeZone = headersList.get("x-vercel-ip-timezone") || undefined;
	return new Date().toLocaleString("en-US", { timeZone });
}

async function getTranscript(input: string | File) {
	if (typeof input === "string") return input;

	const apiKey = process.env.WHISPER_API_KEY;
	if (!apiKey) {
		console.error("WHISPER_API_KEY is not set");
		return null;
	}

	try {
		const form = new FormData();
		form.append("file", input);
		form.append("model", "whisper-1"); // Usar un modelo estándar de Whisper API

		const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiKey}`
			},
			body: form
		});

		if (!res.ok) {
			console.error("OpenAI API Error:", await res.text());
			return null;
		}
		const data = await res.json();
		return (data.text || "").trim() || null;
	} catch (e) {
		console.error("Error calling OpenAI:", e);
		return null;
	}
}
