import { constants } from "fs";
import { link, lstat, open, unlink } from "fs/promises";
import { dirname, isAbsolute, join } from "path";
import { createHash, randomUUID } from "crypto";

function validExportContents(contents: unknown): contents is string {
  return (
    typeof contents === "string" &&
    contents.startsWith('{"record_type":"export_header"') &&
    contents.endsWith("\n") &&
    Buffer.byteLength(contents, "utf8") <= 32 * 1024 * 1024
  );
}

export function validExportRequest(
  filename: unknown,
  contents: unknown
): filename is string {
  return (
    typeof filename === "string" &&
    /^pomatez-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.jsonl$/.test(
      filename
    ) &&
    validExportContents(contents)
  );
}

export async function writeNewExport(
  destination: string,
  contents: string,
  write = async (
    file: Awaited<ReturnType<typeof open>>,
    data: string
  ) => file.writeFile(data, "utf8")
) {
  const temporary = join(
    dirname(destination),
    ".pomatez-" + randomUUID() + ".partial"
  );
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await write(file, contents);
      await file.sync();
    } finally {
      await file.close();
    }
    // Atomically publish a complete file. Existing destinations are never replaced.
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function saveHistoryExport(
  choose: () => Promise<{ canceled: boolean; filePath?: string }>,
  contents: string,
  write = writeNewExport
) {
  const selection = await choose();
  if (selection.canceled || !selection.filePath)
    return { status: "cancelled" };
  try {
    await write(selection.filePath, contents);
    return { status: "saved", path: selection.filePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return { status: "exists" };
    throw error;
  }
}

export async function writeAutomaticExport(
  directory: string,
  filename: unknown,
  contents: unknown
): Promise<"saved" | "unchanged"> {
  if (!isAbsolute(directory) || !validExportContents(contents)) {
    throw new Error("Invalid automatic history export request");
  }
  const digest = createHash("sha256").update(contents).digest("hex");
  if (
    typeof filename !== "string" ||
    filename !== `pomatez-auto-${digest}.jsonl`
  ) {
    throw new Error("Invalid automatic history export filename");
  }

  const destination = join(directory, filename);
  try {
    await writeNewExport(destination, contents);
    return "saved";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const conflict = new Error(
    "A different file already exists at the automatic export destination"
  );
  const expected = Buffer.from(contents, "utf8");
  if (!(await lstat(destination)).isFile()) throw conflict;
  const existing = await open(
    destination,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0)
  );
  try {
    const info = await existing.stat();
    if (!info.isFile() || info.size !== expected.length) throw conflict;
    const actual = Buffer.alloc(expected.length + 1);
    let offset = 0;
    while (offset < actual.length) {
      const { bytesRead } = await existing.read(
        actual,
        offset,
        actual.length - offset,
        offset
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (
      offset === expected.length &&
      actual.subarray(0, offset).equals(expected)
    ) {
      return "unchanged";
    }
    throw conflict;
  } finally {
    await existing.close();
  }
}
