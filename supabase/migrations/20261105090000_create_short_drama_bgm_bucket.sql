insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tracer-drama-bgm', 'tracer-drama-bgm', false, 10485760, array['audio/mpeg','audio/mp3'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
