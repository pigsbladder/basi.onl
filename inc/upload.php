<?php
// ─── Upload handlers ──────────────────────────────────────────────────────────

// Generate a random 5-character site ID (alphanumeric, URL-safe).
function generate_id(): string {
    $chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    $len   = strlen($chars);
    $id    = '';
    $bytes = random_bytes(5);
    for ($i = 0; $i < 5; $i++) {
        $id .= $chars[ord($bytes[$i]) % $len];
    }
    return $id;
}

// Build a safe absolute path inside $base from a relative path,
// stripping any path traversal attempts (../, ./, etc.).
// Returns null if the result would escape $base.
function safe_path(string $base, string $rel): ?string {
    // Normalise separators, strip leading slashes
    $rel   = str_replace('\\', '/', $rel);
    $rel   = ltrim($rel, '/');
    $parts = explode('/', $rel);

    $safe = [];
    foreach ($parts as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..') { array_pop($safe); continue; }  // neutralise traversal
        $safe[] = $part;
    }

    if (empty($safe)) return null;

    // Build final path without resolving symlinks (file may not exist yet)
    $fullPath = $base . '/' . implode('/', $safe);

    // Extra safety: after resolving any symlinks on the base, verify containment
    $realBase = realpath($base);
    if ($realBase) {
        // Normalise the constructed path the same way realpath does (string-only)
        $normPath = $realBase . '/' . implode('/', $safe);
        if (strpos(str_replace('\\', '/', $normPath), str_replace('\\', '/', $realBase) . '/') !== 0) {
            return null;
        }
    }

    return $fullPath;
}

// ── ZIP upload ────────────────────────────────────────────────────────────────

function extract_zip(string $tmpPath, string $dest): void {
    $zip = new ZipArchive();
    if ($zip->open($tmpPath) !== true) {
        throw new RuntimeException('Could not open ZIP file.');
    }

    // Detect a single common root directory (e.g. project/index.html → strip "project/")
    $topDirs = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = $zip->getNameIndex($i);
        $top  = explode('/', $name)[0];
        if ($top !== '') $topDirs[$top] = true;
    }
    $singleRoot = count($topDirs) === 1 ? array_key_first($topDirs) : null;

    for ($i = 0; $i < $zip->numFiles; $i++) {
        $entry = $zip->getNameIndex($i);

        // Skip directory entries
        if (substr($entry, -1) === '/') continue;

        // Strip common root
        $rel = $entry;
        if ($singleRoot !== null && str_starts_with($rel, $singleRoot . '/')) {
            $rel = substr($rel, strlen($singleRoot) + 1);
        }
        if ($rel === '') continue;

        $out = safe_path($dest, $rel);
        if (!$out) continue;

        $dir = dirname($out);
        if (!is_dir($dir)) mkdir($dir, 0755, true);

        file_put_contents($out, $zip->getFromIndex($i));
    }

    $zip->close();
}

// ── Directory upload ──────────────────────────────────────────────────────────
// Receives files[] (multipart array) + paths[] (parallel relative-path array).
// Returns the detected site name (top-level dir name).

function extract_directory_files(string $dest): string {
    if (!isset($_FILES['files'])) {
        throw new RuntimeException('No files received.');
    }

    $f = $_FILES['files'];

    // PHP wraps single-file uploads as scalars — normalise to arrays.
    if (!is_array($f['name'])) {
        $f = array_map(fn($v) => [$v], $f);
    }

    $paths = $_POST['paths'] ?? [];
    if (!is_array($paths)) $paths = [$paths];

    // Detect common root dir to strip and use as the site name.
    $roots = [];
    foreach ($paths as $p) {
        $top = explode('/', ltrim((string)$p, '/'))[0];
        if ($top !== '') $roots[$top] = true;
    }
    $singleRoot = count($roots) === 1 ? array_key_first($roots) : null;
    $name       = $singleRoot ?? basename($dest);

    $count = count($f['name']);
    for ($i = 0; $i < $count; $i++) {
        if ($f['error'][$i] !== UPLOAD_ERR_OK) continue;

        $rel = $paths[$i] ?? $f['name'][$i];
        $rel = ltrim((string)$rel, '/');

        // Strip common root
        if ($singleRoot !== null && str_starts_with($rel, $singleRoot . '/')) {
            $rel = substr($rel, strlen($singleRoot) + 1);
        }

        $out = safe_path($dest, $rel);
        if (!$out) continue;

        $dir = dirname($out);
        if (!is_dir($dir)) mkdir($dir, 0755, true);

        move_uploaded_file($f['tmp_name'][$i], $out);
    }

    return $name;
}
