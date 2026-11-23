-- Sample data for local Supabase / a fresh project.

insert into public.creators (id, username, display_name, headline, bio, avatar_emoji, location, followers, following, posts, mpesa_phone)
values
  ('11111111-1111-4111-8111-111111111111', '1._coastspoter', 'Coast Spotter',
   'Chasing sunsets, classic cars and stories from the Kenyan coast.',
   'I photograph the cars, people and places that make Kenya''s coast feel like home. Every gift keeps me on the road and funding the next shoot.',
   '📸', 'Mombasa, Kenya', 18400, 312, 128, '254712345678'),
  ('22222222-2222-4222-8222-222222222222', 'wanjiku_makes', 'Wanjiku Makes',
   'Handmade ceramics, slow mornings and little jars of joy.',
   'A small pottery studio in Nairobi. Your support buys clay, glazes and kiln time for the next collection.',
   '🏺', 'Nairobi, Kenya', 3200, 187, 64, '254798765432')
on conflict (id) do nothing;

-- Keep profile stats in sync when the seed is re-run on an existing project.
update public.creators set followers = 18400, following = 312, posts = 128
where id = '11111111-1111-4111-8111-111111111111';
update public.creators set followers = 3200, following = 187, posts = 64
where id = '22222222-2222-4222-8222-222222222222';

insert into public.gift_tiers (id, creator_id, title, amount, icon, is_popular, sort_order)
values
  ('aaaaaaa1-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Cake', 50, '🍰', false, 1),
  ('aaaaaaa2-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Soda', 100, '🥤', false, 2),
  ('aaaaaaa3-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'Coffee', 300, '☕', true, 3),
  ('aaaaaaa4-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'Lunch', 500, '🍛', false, 4),
  ('aaaaaaa5-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'Dinner', 1000, '🍽️', false, 5),
  ('bbbbbbb1-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'A little clay', 200, '🫙', false, 1),
  ('bbbbbbb2-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Glaze fund', 600, '🎨', true, 2),
  ('bbbbbbb3-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'Kiln time', 1500, '🔥', false, 3)
on conflict (id) do nothing;

insert into public.transactions (id, creator_id, supporter_name, supporter_message, gift_title, amount, phone_number, status, mpesa_receipt_number, checkout_request_id)
values
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Amina', 'The Mombasa sunset series is unreal. Keep going!', 'Coffee', 300, '254712345678', 'SUCCESS', 'DEMO8K2P41', 'demo_seed_1'),
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 'Brian K.', 'For the next road trip 🚗', 'Lunch', 500, '254733345678', 'SUCCESS', 'DEMO4M9X22', 'demo_seed_2'),
  ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222', 'Njeri', 'Can''t wait for the new mugs!', 'Glaze fund', 600, '254722345678', 'SUCCESS', 'DEMO7T1Q80', 'demo_seed_3')
on conflict (id) do nothing;
