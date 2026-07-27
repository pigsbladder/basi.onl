<?php
// ─── Static file serving ──────────────────────────────────────────────────────

function serve_site(string $id, string $subpath): void {
    $site = get_site($id);
    if (!$site) {
        http_response_code(404);
        echo '<h1>404</h1><p>Site not found.</p>';
        return;
    }

    // Show password prompt if protected and no valid access cookie
    if ($site['protected'] && !site_has_access($id)) {
        render_password_prompt($id);
        return;
    }

    $siteDir  = SITES_DIR . '/' . $id;
    $realBase = realpath($siteDir);

    if (!$realBase) {
        http_response_code(404);
        echo '<h1>404</h1><p>Site files not found.</p>';
        return;
    }

    // Normalise subpath: empty or "/" → serve index.html
    $subpath = ($subpath === '' || $subpath === '/') ? '/index.html' : $subpath;

    // Resolve the target file path
    $target = $realBase . $subpath;

    // If it's a directory, try index.html inside it
    if (is_dir($target)) {
        $target = rtrim($target, '/') . '/index.html';
    }

    // Security: ensure the resolved path stays within the site directory
    $realTarget = realpath($target);
    if (!$realTarget || strpos($realTarget, $realBase) !== 0) {
        http_response_code(403);
        echo '<h1>403</h1><p>Forbidden.</p>';
        return;
    }

    if (!file_exists($realTarget)) {
        // SPA fallback: serve index.html for unknown paths
        $index = $realBase . '/index.html';
        if (file_exists($index)) {
            serve_file($index);
        } else {
            http_response_code(404);
            echo '<h1>404</h1><p>File not found.</p>';
        }
        return;
    }

    serve_file($realTarget);
}

// Output a file with the correct Content-Type header.
function serve_file(string $path): void {
    // Close the session before streaming so we don't hold the session lock
    // for the entire duration of the file transfer.
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

    // Discard any output-buffer content that PHP or the host may have started,
    // so our Content-Length stays accurate.
    while (ob_get_level()) ob_end_clean();

    $mime = get_mime_type($path);
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($path));

    // Cache static assets for 1 hour
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    if (in_array($ext, ['css','js','png','jpg','jpeg','gif','svg','ico','woff','woff2','ttf','webp'])) {
        header('Cache-Control: public, max-age=3600');
    } else {
        header('Cache-Control: no-cache');
    }

    readfile($path);
    exit;
}

// Map file extension to MIME type.
function get_mime_type(string $path): string {
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    return [
        'html'  => 'text/html; charset=utf-8',
        'htm'   => 'text/html; charset=utf-8',
        'css'   => 'text/css',
        'js'    => 'application/javascript',
        'mjs'   => 'application/javascript',
        'json'  => 'application/json',
        'xml'   => 'application/xml',
        'txt'   => 'text/plain',
        'md'    => 'text/plain',
        'svg'   => 'image/svg+xml',
        'png'   => 'image/png',
        'jpg'   => 'image/jpeg',
        'jpeg'  => 'image/jpeg',
        'gif'   => 'image/gif',
        'webp'  => 'image/webp',
        'ico'   => 'image/x-icon',
        'woff'  => 'font/woff',
        'woff2' => 'font/woff2',
        'ttf'   => 'font/ttf',
        'otf'   => 'font/otf',
        'eot'   => 'application/vnd.ms-fontobject',
        'mp4'   => 'video/mp4',
        'webm'  => 'video/webm',
        'mp3'   => 'audio/mpeg',
        'pdf'   => 'application/pdf',
        'zip'   => 'application/zip',
    ][$ext] ?? 'application/octet-stream';
}
