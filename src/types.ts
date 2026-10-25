export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface Chat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface FileRef {
  file_id: string;
  file_size?: number;
}

export interface PhotoSize extends FileRef {
  width: number;
  height: number;
}

export interface NamedFile extends FileRef {
  file_name?: string;
  mime_type?: string;
}

export interface Message {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  date: number;
  chat: Chat;
  from?: User;
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: NamedFile;
  audio?: NamedFile;
  voice?: NamedFile;
  video?: NamedFile;
  video_note?: FileRef;
  sticker?: FileRef;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}

export interface Update {
  update_id: number;
  message?: Message;
}

export interface TelegramFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}

export interface WebhookInfo {
  url: string;
}

export interface ResponseParameters {
  migrate_to_chat_id?: number;
  retry_after?: number;
}
