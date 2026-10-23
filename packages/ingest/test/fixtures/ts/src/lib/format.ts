export interface User {
  id: string;
  name: string;
  disabled?: boolean;
}

export function formatUser(user: User): string {
  return `${user.id}: ${user.name}`;
}
