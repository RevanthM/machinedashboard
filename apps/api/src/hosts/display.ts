/** Display name: nickname wins over inventory name. */
export function displayName(host: { name: string; nickname?: string | null }): string {
  const nick = host.nickname?.trim();
  return nick || host.name;
}
