-- WhatsApp AI Agent - Supabase Schema
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- Table: conversations
-- One record per unique phone number
create table if not exists conversations (
  id           uuid primary key default gen_random_uuid(),
  phone_number text unique not null,
  created_at   timestamp with time zone default now(),
  updated_at   timestamp with time zone default now()
);

-- Table: messages
-- Stores every message (user and assistant) per conversation
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  created_at      timestamp with time zone default now()
);

-- Index to speed up history queries
create index if not exists messages_conversation_id_created_at
  on messages (conversation_id, created_at desc);

-- Auto-update conversations.updated_at whenever a new message is inserted
create or replace function update_conversation_timestamp()
returns trigger language plpgsql as $$
begin
  update conversations
  set updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

create or replace trigger trg_update_conversation_timestamp
after insert on messages
for each row execute function update_conversation_timestamp();

-- Table: processed_messages
-- Prevents duplicate processing when Meta resends the same webhook
-- across different serverless instances (Vercel).
create table if not exists processed_messages (
  message_id text primary key,
  created_at timestamp with time zone default now()
);

-- Auto-delete entries older than 10 minutes to keep the table small
create or replace function cleanup_processed_messages()
returns trigger language plpgsql as $$
begin
  delete from processed_messages
  where created_at < now() - interval '10 minutes';
  return new;
end;
$$;

create or replace trigger trg_cleanup_processed_messages
after insert on processed_messages
for each row execute function cleanup_processed_messages();
