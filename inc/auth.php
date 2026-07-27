<?php
// ─── Auth helpers ─────────────────────────────────────────────────────────────

// Sign a value with HMAC so it can be stored in a cookie safely.
function sign_value(string $val): string {
    $sig = hash_hmac('sha256', $val, SECRET_KEY);
    return $val . '.' . $sig;
}

// Verify a signed cookie value. Returns the original value on success, false on failure.
function verify_signed_value(string $signed): string|false {
    $lastDot = strrpos($signed, '.');
    if ($lastDot === false) return false;
    $val   = substr($signed, 0, $lastDot);
    $check = sign_value($val);
    return hash_equals($check, $signed) ? $val : false;
}

// Check if the current request has a valid admin session.
function is_admin_logged_in(): bool {
    return !empty($_SESSION['admin'])
        && $_SESSION['admin'] === true
        && !empty($_SESSION['admin_until'])
        && $_SESSION['admin_until'] > time();
}

// Enforce admin auth. For JSON API routes pass $json = true to get a 401
// instead of a redirect.
function require_admin(bool $json = false): void {
    if (!is_admin_logged_in()) {
        if ($json) {
            http_response_code(401);
            header('Content-Type: application/json');
            echo json_encode(['error' => 'Unauthorized']);
            exit;
        }
        header('Location: /admin/login');
        exit;
    }
}

// Check if the visitor has a valid access cookie for a password-protected site.
function site_has_access(string $id): bool {
    $cookie = $_COOKIE["site_{$id}"] ?? '';
    if (!$cookie) return false;
    $val = verify_signed_value($cookie);
    return $val === "site:{$id}";
}
