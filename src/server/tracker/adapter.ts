export interface Ticket {
  key: string; title: string; body: string; url: string; status: string;
}
export interface TrackerAdapter {
  kind: 'jira' | 'youtrack' | 'linear' | 'none';
  whoami(): Promise<{ accountId: string; displayName: string } | null>;
  searchAssigned(): Promise<Ticket[]>;
  searchRecent(): Promise<Ticket[]>;
  getTicket(key: string): Promise<Ticket | null>;
  createTicket(input: { title: string; body: string; project?: string }): Promise<Ticket | null>;
  postComment(key: string, body: string): Promise<void>;
}
