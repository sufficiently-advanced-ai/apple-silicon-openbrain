import { $ } from "bun";

export interface YouTubeResult {
  title: string;
  channel: string;
  transcript: string;
  videoId: string;
  /** ISO date (YYYY-MM-DD) the video was uploaded, when yt-dlp reports it. */
  uploadDate: string | null;
}

const VIDEO_ID_RE = /(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

export function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url);
}

export function extractVideoId(url: string): string | null {
  return url.match(VIDEO_ID_RE)?.[1] ?? null;
}

export async function fetchYouTubeTranscript(url: string): Promise<YouTubeResult> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error("Could not extract YouTube video ID");

  // Get metadata
  const metaResult = await $`yt-dlp --dump-json --skip-download ${url}`.quiet();
  if (metaResult.exitCode !== 0) {
    throw new Error(`yt-dlp metadata failed: ${metaResult.stderr.toString()}`);
  }
  const meta = JSON.parse(metaResult.stdout.toString()) as {
    title?: string;
    channel?: string;
    uploader?: string;
    upload_date?: string;
    duration_string?: string;
    description?: string;
  };

  // Get transcript
  const tmpDir = `/tmp/openbrain-yt-${videoId}`;
  try {
    await $`mkdir -p ${tmpDir}`.quiet();

    // Try manual subs first, then auto subs
    const subResult = await $`yt-dlp --write-sub --write-auto-sub --sub-lang en --skip-download --sub-format json3 -o ${tmpDir}/sub ${url}`.quiet();

    const subFile = Bun.file(`${tmpDir}/sub.en.json3`);
    if (!(await subFile.exists())) {
      throw new Error("No English subtitles available for this video");
    }

    const data = JSON.parse(await subFile.text()) as {
      events?: { segs?: { utf8?: string }[] }[];
    };

    const lines: string[] = [];
    for (const event of data.events ?? []) {
      const text = (event.segs ?? [])
        .map((s) => s.utf8 ?? "")
        .join("")
        .trim();
      if (text && text !== "\n") lines.push(text);
    }

    const transcript = lines.join(" ");
    if (!transcript) throw new Error("Transcript was empty");

    const title = meta.title ?? "YouTube Video";
    const channel = meta.channel ?? meta.uploader ?? "Unknown";
    const date = meta.upload_date
      ? `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}`
      : "";
    const duration = meta.duration_string ?? "";

    // Format content with metadata header
    const content = [
      `# ${title}`,
      `**Channel:** ${channel}${date ? ` | **Date:** ${date}` : ""}${duration ? ` | **Duration:** ${duration}` : ""}`,
      "",
      "## Transcript",
      "",
      transcript,
    ].join("\n");

    return { title, channel, transcript: content, videoId, uploadDate: date || null };
  } finally {
    await $`rm -rf ${tmpDir}`.quiet();
  }
}
