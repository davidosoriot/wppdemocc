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
