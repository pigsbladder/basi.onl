<?php
// ─── basi.onl configuration ───────────────────────────────────────────────────
// Edit these two values before deploying.

define('SECRET_KEY',     'clHpURJPiwMV3TrjVZfTU6oePJWbAMoXEDdKYEahJIg6ZaBDDKqzYpr9N1j2vGYQ');  // used to sign cookies
define('ADMIN_PASSWORD', 'modified-essay-liable-omen-broker-brussels');                 // /admin login password

// ─── Paths (no need to edit these) ───────────────────────────────────────────
define('SITES_DIR',  __DIR__ . '/sites');
define('DATA_DIR',   __DIR__ . '/data');
define('DATA_FILE',  __DIR__ . '/data/sites.json');

// Ensure required directories and data file exist on first run
if (!is_dir(SITES_DIR)) mkdir(SITES_DIR, 0755, true);
if (!is_dir(DATA_DIR))  mkdir(DATA_DIR,  0755, true);
if (!file_exists(DATA_FILE)) file_put_contents(DATA_FILE, '[]');
