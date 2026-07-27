<?php
// ─── sites.json metadata helpers ─────────────────────────────────────────────

function read_meta(): array {
    $raw = @file_get_contents(DATA_FILE);
    if ($raw === false) return [];
    return json_decode($raw, true) ?? [];
}

function write_meta(array $data): void {
    file_put_contents(DATA_FILE, json_encode($data, JSON_PRETTY_PRINT));
}

function get_site(string $id): ?array {
    foreach (read_meta() as $site) {
        if ($site['id'] === $id) return $site;
    }
    return null;
}

function upsert_site(array $site): void {
    $all = read_meta();
    $found = false;
    foreach ($all as &$s) {
        if ($s['id'] === $site['id']) { $s = $site; $found = true; break; }
    }
    if (!$found) $all[] = $site;
    write_meta($all);
}

function delete_site_from_meta(string $id): void {
    write_meta(array_values(array_filter(read_meta(), fn($s) => $s['id'] !== $id)));
}
