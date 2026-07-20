-- APS bulut çıkarım işi durumu: yerel parser yapısal veri bulamayınca run bulut
-- yoluna geçer; urn/guid burada saklanır ve /advance endpoint'i ilerletir.
alter table public.runs add column if not exists aps jsonb;
