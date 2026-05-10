/**
 * GET /api/system/volume-check — Inspect volume disk usage for /app/data
 *
 * Returns the size of the DATA_DIR directory, individual file sizes, and
 * disk usage statistics. Useful for diagnosing volume capacity issues
 * without requiring SSH access or Railway CLI.
 *
 * Security: Requires admin authentication.
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { DATA_DIR, SQLITE_FILE } from "@/lib/db/core";

export const dynamic = "force-dynamic";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number;
  size: string;
  modifiedAt: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function getEntrySize(entryPath: string, stat: fs.Stats): number {
  if (stat.isDirectory()) {
    return getDirectorySize(entryPath);
  }
  return stat.size;
}

function getDirectorySize(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          total += getDirectorySize(fullPath);
        } else {
          total += stat.size;
        }
      } catch {
        // Skip entries we can't stat (permission errors, broken symlinks, etc.)
      }
    }
  } catch {
    // Directory unreadable
  }
  return total;
}

function listTopLevelEntries(dirPath: string): FileEntry[] {
  const entries: FileEntry[] = [];

  let dirContents: fs.Dirent[];
  try {
    dirContents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const dirent of dirContents) {
    const fullPath = path.join(dirPath, dirent.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    let type: FileEntry["type"] = "other";
    if (stat.isFile()) type = "file";
    else if (stat.isDirectory()) type = "directory";
    else if (stat.isSymbolicLink()) type = "symlink";

    const sizeBytes = getEntrySize(fullPath, stat);

    entries.push({
      name: dirent.name,
      path: fullPath,
      type,
      sizeBytes,
      size: formatBytes(sizeBytes),
      modifiedAt: stat.mtime ? stat.mtime.toISOString() : null,
    });
  }

  // Sort largest first
  entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return entries;
}

function getDiskUsage(dirPath: string): {
  available: string | null;
  total: string | null;
  used: string | null;
  usedPercent: string | null;
} {
  try {
    // Node.js 18.15+ / 19.6+ exposes statfs
    const statfs = (fs as any).statfsSync;
    if (typeof statfs !== "function") {
      return { available: null, total: null, used: null, usedPercent: null };
    }

    const stats = statfs(dirPath);
    const blockSize: number = stats.bsize;
    const totalBytes: number = stats.blocks * blockSize;
    const availableBytes: number = stats.bavail * blockSize;
    const usedBytes: number = totalBytes - availableBytes;
    const usedPercent =
      totalBytes > 0 ? `${Math.round((usedBytes / totalBytes) * 100)}%` : null;

    return {
      available: formatBytes(availableBytes),
      total: formatBytes(totalBytes),
      used: formatBytes(usedBytes),
      usedPercent,
    };
  } catch {
    return { available: null, total: null, used: null, usedPercent: null };
  }
}

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dataDir = DATA_DIR;
  const sqliteFile = SQLITE_FILE;

  // Check if DATA_DIR exists
  let dataDirExists = false;
  try {
    dataDirExists = fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory();
  } catch {
    dataDirExists = false;
  }

  if (!dataDirExists) {
    return NextResponse.json(
      {
        error: `DATA_DIR does not exist or is not a directory`,
        dataDir,
        sqliteFile,
      },
      { status: 404 }
    );
  }

  // Total size of DATA_DIR
  const totalSizeBytes = getDirectorySize(dataDir);

  // SQLite file stats
  let sqliteStats: { sizeBytes: number; size: string; exists: boolean } = {
    sizeBytes: 0,
    size: "0 B",
    exists: false,
  };
  if (sqliteFile) {
    try {
      const stat = fs.statSync(sqliteFile);
      sqliteStats = {
        sizeBytes: stat.size,
        size: formatBytes(stat.size),
        exists: true,
      };
    } catch {
      sqliteStats = { sizeBytes: 0, size: "0 B", exists: false };
    }
  }

  // Top-level entries in DATA_DIR
  const files = listTopLevelEntries(dataDir);

  // Disk usage for the filesystem containing DATA_DIR
  const diskUsage = getDiskUsage(dataDir);

  return NextResponse.json({
    dataDir,
    sqliteFile,
    totalSize: formatBytes(totalSizeBytes),
    totalSizeBytes,
    sqlite: {
      path: sqliteFile,
      ...sqliteStats,
    },
    files: files.map((f) => ({
      name: f.name,
      type: f.type,
      size: f.size,
      sizeBytes: f.sizeBytes,
      modifiedAt: f.modifiedAt,
    })),
    diskUsage: {
      used: diskUsage.used,
      available: diskUsage.available,
      total: diskUsage.total,
      usedPercent: diskUsage.usedPercent,
    },
    generatedAt: new Date().toISOString(),
  });
}
