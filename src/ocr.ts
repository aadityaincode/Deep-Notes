import { App, normalizePath, TFile } from "obsidian";

export interface OCRSettings {
	enabled: boolean;
	provider: "ollama" | "gemini";
	visionModel: string; // for Ollama
	maxImages: number;
	ollamaBaseUrl: string;
	apiKey?: string; // for Gemini
}

export interface OCRExtractionResult {
	text: string;
	debugLines: string[];
}

export function collectReferencedImagePaths(
	app: App,
	sourceFile: TFile,
	noteContent: string,
	maxImages: number
): string[] {
	const imageFiles = resolveReferencedImageFiles(app, sourceFile.path, noteContent, maxImages);
	return imageFiles.map((file) => file.path);
}

export async function extractOcrDataFromNoteImages(
	app: App,
	sourceFile: TFile,
	noteContent: string,
	settings: OCRSettings
): Promise<OCRExtractionResult> {
	if (!settings.enabled) {
		return { text: "", debugLines: ["OCR disabled in settings."] };
	}

	const imageFiles = resolveReferencedImageFiles(app, sourceFile.path, noteContent, settings.maxImages);

	if (imageFiles.length === 0) {
		return { text: "", debugLines: ["No supported referenced image sources detected."] };
	}

	const extractedBlocks: string[] = [];
	const debugLines: string[] = [
		`Detected ${imageFiles.length} OCR source(s).`,
		`Vision Provider: ${settings.provider}`,
	];

	if (settings.provider === "ollama") {
		debugLines.push(`Vision model: ${settings.visionModel}`);
		debugLines.push(`Ollama base URL: ${(settings.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/$/, "")}`);
	} else {
		debugLines.push(`Gemini model: gemini-2.0-flash`);
	}

	for (let index = 0; index < imageFiles.length; index++) {
		const imageFile = imageFiles[index];
		if (isExcalidrawFile(imageFile)) {
			const textElements = await extractExcalidrawTextElements(app, imageFile);
			const lineCount = textElements ? textElements.split("\n").filter((line) => line.trim().length > 0).length : 0;
			debugLines.push(
				`[${index + 1}] ${imageFile.path} (excalidraw): parsed local Text Elements (${lineCount} line(s)); no image upload performed.`
			);
			extractedBlocks.push(
				[
					`### Image ${index + 1}: ${imageFile.basename}`,
					`Reference: [[${imageFile.path}]]`,
					`Path: ${imageFile.path}`,
					textElements || "[No readable text extracted]",
				].join("\n")
			);
			continue;
		}

		try {
			const { base64, bytes } = await readImageAsBase64(app, imageFile);
			const mimeType = extensionToMime(imageFile.extension);

			let text = "";
			if (settings.provider === "gemini") {
				if (!settings.apiKey) {
					throw new Error("Gemini API key is required for Vision OCR.");
				}
				debugLines.push(
					`[${index + 1}] ${imageFile.path} (raster): uploading ${bytes} bytes to Gemini Vision...`
				);
				text = await runGeminiVisionOCR(base64, mimeType, settings.apiKey);
			} else {
				debugLines.push(
					`[${index + 1}] ${imageFile.path} (raster): uploading ${bytes} bytes to Ollama vision model '${settings.visionModel}'...`
				);
				text = await runOllamaVisionOCR(base64, settings.visionModel, settings.ollamaBaseUrl);
			}

			const cleaned = text.trim();
			debugLines.push(
				`[${index + 1}] OCR extraction result: ${cleaned ? `${cleaned.length} character(s)` : "no readable text"}.`
			);
			extractedBlocks.push(
				[
					`### Image ${index + 1}: ${imageFile.basename}`,
					`Reference: [[${imageFile.path}]]`,
					`Path: ${imageFile.path}`,
					cleaned || "[No readable text extracted]",
				].join("\n")
			);
		} catch (error) {
			debugLines.push(
				`[${index + 1}] OCR failed for ${imageFile.path}: ${error instanceof Error ? error.message : String(error)}`
			);
			continue;
		}
	}

	return {
		text: extractedBlocks.join("\n\n"),
		debugLines,
	};
}

export async function extractOcrTextFromNoteImages(
	app: App,
	sourceFile: TFile,
	noteContent: string,
	settings: OCRSettings
): Promise<string> {
	const result = await extractOcrDataFromNoteImages(app, sourceFile, noteContent, settings);
	return result.text;
}

function resolveReferencedImageFiles(
	app: App,
	sourcePath: string,
	noteContent: string,
	maxImages: number
): TFile[] {
	const rawLinks = extractEmbeddedImageLinks(noteContent);
	if (rawLinks.length === 0) return [];

	const seen = new Set<string>();
	const imageFiles: TFile[] = [];
	for (const link of rawLinks) {
		const resolved = resolveImageFile(app, sourcePath, link);
		if (!resolved) continue;
		if (seen.has(resolved.path)) continue;
		seen.add(resolved.path);
		imageFiles.push(resolved);
		if (imageFiles.length >= maxImages) break;
	}

	return imageFiles;
}

function extractEmbeddedImageLinks(noteContent: string): string[] {
	const links: string[] = [];

	const wikiEmbedRegex = /!\[\[([^\]]+)\]\]/g;
	for (const match of noteContent.matchAll(wikiEmbedRegex)) {
		const raw = (match[1] ?? "").split("|")[0]?.trim();
		if (raw) links.push(raw);
	}

	const markdownImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
	for (const match of noteContent.matchAll(markdownImageRegex)) {
		const raw = (match[1] ?? "").trim();
		if (raw) links.push(raw);
	}

	return links;
}

function resolveImageFile(app: App, sourcePath: string, rawLink: string): TFile | null {
	const cleaned = rawLink
		.replace(/^</, "")
		.replace(/>$/, "")
		.replace(/\s+"[^"]*"\s*$/, "")
		.replace(/\s+'[^']*'\s*$/, "")
		.split("#")[0]
		.trim();
	if (!cleaned) return null;
	if (/^https?:\/\//i.test(cleaned)) return null;

	const candidateLinks = new Set<string>();
	candidateLinks.add(cleaned);

	try {
		candidateLinks.add(decodeURIComponent(cleaned));
	} catch {
		// ignore decode issues
	}

	for (const candidate of Array.from(candidateLinks)) {
		if (candidate.startsWith("./")) {
			candidateLinks.add(candidate.slice(2));
		}
	}

	let target: TFile | null = null;
	for (const candidate of candidateLinks) {
		const resolved = app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
		if (resolved && resolved instanceof TFile) {
			target = resolved;
			break;
		}
	}

	if (!target) {
		const sourceDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
		for (const candidate of candidateLinks) {
			const maybeRelative = normalizePath(sourceDir ? `${sourceDir}/${candidate}` : candidate);
			const abs = app.vault.getAbstractFileByPath(maybeRelative);
			if (abs && abs instanceof TFile) {
				target = abs;
				break;
			}
		}
	}

	if (!target || !(target instanceof TFile)) return null;

	const ext = target.extension.toLowerCase();
	const isImage = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "svg"].includes(ext);
	if (isImage) return target;
	if (isExcalidrawFile(target)) return target;
	return null;
}

function isExcalidrawFile(file: TFile): boolean {
	if (file.extension.toLowerCase() === "excalidraw") return true;
	if (file.extension.toLowerCase() === "md" && file.basename.toLowerCase().endsWith(".excalidraw")) {
		return true;
	}
	return false;
}

async function extractExcalidrawTextElements(app: App, file: TFile): Promise<string> {
	try {
		const content = await app.vault.read(file);
		const sectionMatch = content.match(/## Text Elements\n([\s\S]*?)(\n%%|\n## |$)/);
		if (!sectionMatch) return "";

		const lines = sectionMatch[1]
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.filter((line) => !line.startsWith("%%"))
			.map((line) => line.replace(/\s*\^[A-Za-z0-9_-]+$/, "").trim())
			.filter((line) => line.length > 0);

		return lines.join("\n");
	} catch {
		return "";
	}
}

/**
 * Parse the "## Embedded Files" section of an Excalidraw .md file.
 * Returns wikilink names like "Screenshot 2026-01-19 at 14.10.56.png".
 */
function extractExcalidrawEmbeddedImageLinks(content: string): string[] {
	const sectionMatch = content.match(/## Embedded Files\n([\s\S]*?)(\n%%|\n## |$)/);
	if (!sectionMatch) return [];
	const links: string[] = [];
	const wikiRegex = /\[\[([^\]]+)\]\]/g;
	for (const m of sectionMatch[1].matchAll(wikiRegex)) {
		const raw = (m[1] ?? "").split("|")[0]?.trim();
		if (raw) links.push(raw);
	}
	return links;
}

/**
 * For an Excalidraw file, load the actual embedded screenshot/photo files
 * directly from the vault. These are the real images (PNG/JPG) that the
 * user pasted into the drawing — no rendering needed.
 */
export async function resolveExcalidrawEmbeddedImages(
	app: App,
	excalidrawPath: string
): Promise<ImagePayload[]> {
	const file = app.vault.getAbstractFileByPath(excalidrawPath);
	if (!file || !(file instanceof TFile)) return [];

	try {
		const content = await app.vault.read(file);
		const embeddedLinks = extractExcalidrawEmbeddedImageLinks(content);
		if (embeddedLinks.length === 0) {
			console.log(`[Deep Notes] No embedded images in ${excalidrawPath}`);
			return [];
		}

		console.log(`[Deep Notes] Found ${embeddedLinks.length} embedded image(s) in ${excalidrawPath}: ${embeddedLinks.join(", ")}`);

		const results: ImagePayload[] = [];
		for (const link of embeddedLinks) {
			const resolved = app.metadataCache.getFirstLinkpathDest(link, excalidrawPath);
			if (!resolved || !(resolved instanceof TFile)) {
				console.warn(`[Deep Notes] Could not resolve embedded image: ${link}`);
				continue;
			}

			const ext = resolved.extension.toLowerCase();
			if (!["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) {
				continue;
			}

			try {
				const { base64, bytes } = await readImageAsBase64(app, resolved);
				console.log(`[Deep Notes] Loaded embedded image: ${resolved.path} (${bytes} bytes)`);
				results.push({
					base64,
					mimeType: extensionToMime(ext),
					path: resolved.path,
					bytes,
				});
			} catch (err) {
				console.warn(`[Deep Notes] Failed to read embedded image ${resolved.path}:`, err);
			}
		}

		return results;
	} catch (err) {
		console.warn(`[Deep Notes] Failed to process ${excalidrawPath}:`, err);
		return [];
	}
}

/**
 * Extract the hand-drawn text annotations from an Excalidraw file's
 * "## Text Elements" section. Returns them as a single string.
 */
export async function extractExcalidrawAnnotations(
	app: App,
	excalidrawPath: string
): Promise<string> {
	const file = app.vault.getAbstractFileByPath(excalidrawPath);
	if (!file || !(file instanceof TFile)) return "";
	return extractExcalidrawTextElements(app, file);
}

export interface ImagePayload {
	base64: string;
	mimeType: string;
	path: string;
	bytes: number;
}

function extensionToMime(ext: string): string {
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		webp: "image/webp",
		gif: "image/gif",
		bmp: "image/bmp",
		tiff: "image/tiff",
		svg: "image/svg+xml",
	};
	return map[ext.toLowerCase()] || "image/png";
}

export interface ImageInfo {
	path: string;
	name: string;
	extension: string;
	isExcalidraw: boolean;
}

export function listEmbeddedImages(
	app: App,
	sourceFile: TFile,
	noteContent: string
): ImageInfo[] {
	// No maxImages limit — show ALL images so the user can pick
	const rawLinks = extractEmbeddedImageLinks(noteContent);
	const seen = new Set<string>();
	const results: ImageInfo[] = [];
	for (const link of rawLinks) {
		const resolved = resolveImageFile(app, sourceFile.path, link);
		if (!resolved) continue;
		if (seen.has(resolved.path)) continue;
		seen.add(resolved.path);
		results.push({
			path: resolved.path,
			name: resolved.basename,
			extension: resolved.extension,
			isExcalidraw: isExcalidrawFile(resolved),
		});
	}
	return results;
}

export interface ExcalidrawContent {
	path: string;
	text: string;
	embeddedImages: ImagePayload[];
}

/**
 * Use the Excalidraw plugin API to render drawings as PNG images.
 * Returns ImagePayload[] — each Excalidraw drawing becomes a regular image.
 */
export async function renderExcalidrawAsPNG(
	paths: string[]
): Promise<ImagePayload[]> {
	const ea = (window as any).ExcalidrawAutomate?.getAPI?.();
	if (!ea) {
		console.warn("[Deep Notes] Excalidraw plugin API not available. Install obsidian-excalidraw-plugin.");
		return [];
	}

	const results: ImagePayload[] = [];
	try {
		// Create proper export settings and loader so embedded screenshots render
		const exportSettings = ea.getExportSettings
			? ea.getExportSettings(true, true) // withBackground=true, withTheme=true
			: { withBackground: true, withTheme: true, isMask: false };
		const loader = ea.getEmbeddedFilesLoader
			? ea.getEmbeddedFilesLoader(false) // isDark=false (light theme)
			: null;

		for (const p of paths) {
			try {
				console.log(`[Deep Notes] Rendering Excalidraw: ${p}`);
				const dataUrl: string = await ea.createPNGBase64(
					p,              // vault-relative path
					2,              // scale (2x for better quality)
					exportSettings, // proper settings with background
					loader,         // proper loader for embedded files
					"light",        // theme
					10              // padding
				);

				if (!dataUrl) {
					console.warn(`[Deep Notes] Empty result for ${p}`);
					continue;
				}

				// dataUrl is "data:image/png;base64,..."
				const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
				const bytes = Math.round(base64.length * 0.75);

				console.log(`[Deep Notes] Rendered ${p}: ${bytes} bytes`);

				results.push({
					base64,
					mimeType: "image/png",
					path: p,
					bytes,
				});
			} catch (err) {
				console.warn(`[Deep Notes] Failed to render ${p}:`, err);
			}
		}
	} finally {
		try { ea.destroy(); } catch { /* ignore */ }
	}

	return results;
}

export async function loadImagesByPaths(
	app: App,
	paths: string[]
): Promise<ImagePayload[]> {
	const results: ImagePayload[] = [];
	for (const p of paths) {
		const file = app.vault.getAbstractFileByPath(p);
		if (!file || !(file instanceof TFile)) continue;
		try {
			const { base64, bytes } = await readImageAsBase64(app, file);
			results.push({
				base64,
				mimeType: extensionToMime(file.extension),
				path: file.path,
				bytes,
			});
		} catch {
			// skip unreadable
		}
	}
	return results;
}

export async function collectBase64Images(
	app: App,
	sourceFile: TFile,
	noteContent: string,
	maxImages: number
): Promise<ImagePayload[]> {
	const imageFiles = resolveReferencedImageFiles(app, sourceFile.path, noteContent, maxImages);
	const results: ImagePayload[] = [];
	for (const file of imageFiles) {
		if (isExcalidrawFile(file)) continue; // skip excalidraw (not a raster image)
		try {
			const { base64, bytes } = await readImageAsBase64(app, file);
			results.push({
				base64,
				mimeType: extensionToMime(file.extension),
				path: file.path,
				bytes,
			});
		} catch {
			// skip unreadable files
		}
	}
	return results;
}

async function readImageAsBase64(app: App, imageFile: TFile): Promise<{ base64: string; bytes: number }> {
	const data = await app.vault.readBinary(imageFile);
	return {
		base64: arrayBufferToBase64(data),
		bytes: data.byteLength,
	};
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

async function runOllamaVisionOCR(
	imageBase64: string,
	visionModel: string,
	baseUrl: string
): Promise<string> {
	const normalizedBase = (baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
	const response = await fetch(`${normalizedBase}/api/chat`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: visionModel,
			stream: false,
			messages: [
				{
					role: "user",
					content:
						"Extract and transcribe all readable text from this image. Return plain text only. If no readable text is present, return an empty string.",
					images: [imageBase64],
				},
			],
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		if (response.status === 404 && /not found/i.test(err)) {
			throw new Error(`Vision model '${visionModel}' not found. Run: ollama pull ${visionModel}`);
		}
		throw new Error(`Ollama vision OCR error (${response.status}): ${err}`);
	}

	const data = await response.json();
	return data.message?.content ?? "";
}

async function runGeminiVisionOCR(
	imageBase64: string,
	mimeType: string,
	apiKey: string,
	model = "gemini-2.0-flash"
): Promise<string> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [
				{
					role: "user",
					parts: [
						{
							inlineData: {
								mimeType: mimeType,
								data: imageBase64,
							},
						},
						{
							text: "Extract and transcribe all readable text from this image. Return plain text only. If no readable text is present, return an empty string.",
						},
					],
				},
			],
			generationConfig: {
				temperature: 0.2, // Low temp for OCR accuracy
			},
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Gemini Vision API error (${response.status}): ${err}`);
	}

	const data = await response.json();
	return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
