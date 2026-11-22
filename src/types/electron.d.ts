export {};
declare global {
  interface Window {
    electronAPI?: {
      getMachineId(): string;
    };
    kashirAnnouncer?: {
      list(): Promise<AnnouncementItem[]>;
      create(payload: { title: string; text: string }): Promise<AnnouncementItem>;
      readAudio(id: string): Promise<string>;
      remove(id: string): Promise<boolean>;
    };
  }
  interface AnnouncementItem {
    id: string;
    title: string;
    text: string;
    fileName: string;
    createdAt: string;
  }
}
