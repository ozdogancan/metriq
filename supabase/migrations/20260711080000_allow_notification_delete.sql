-- Bildirim silme özelliği (tek/tümü) için service_role'e delete yetkisi.
-- 20260710201730_harden_server_only_access.sql bildirimlerde delete'i kapsamıyordu;
-- silme artık üründe kullanıcıya açık bir eylem (DELETE /api/notifications).
grant delete on table public.notifications to service_role;
