-- Bộ mẫu chặn quyền theo công ty bằng RLS của Postgres (công thức gói Chắc: Workers + Hyperdrive + Postgres).
-- Chép vào app thành migration, đổi tên bảng/cột theo app (giữ nguyên khuôn: tenant_id + RLS bật và ép + vai không BYPASSRLS).
-- Worker đặt hai biến cho MỖI giao dịch bằng set_config('app.tenant_id', <uuid>, true) và set_config('app.user_id', <uuid>, true);
-- "true" = chỉ hiệu lực tới hết giao dịch (Hyperdrive gom kết nối theo giao dịch). Chưa đặt ⇒ hàm trả NULL ⇒ không dòng nào qua policy.
-- Chạy bằng vai CHỦ BẢNG (migration), không bao giờ bằng vai ứng dụng. Mật khẩu của app_rw đặt ngoài file này (ALTER ROLE ... PASSWORD).
-- Bài kiểm chạy lại được: rls.test.mjs cạnh file này (xem đầu file đó).

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Vai của ứng dụng: không phải superuser, không BYPASSRLS (vai có BYPASSRLS bỏ qua RLS hoàn toàn), không sở hữu bảng.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN;
  END IF;
END
$$;
ALTER ROLE app_rw NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public, app TO app_rw;
GRANT EXECUTE ON FUNCTION app.tenant_id(), app.user_id() TO app_rw;

-- Công ty. Ứng dụng chỉ thấy dòng của chính công ty mình, chỉ đổi được tên; tạo/xoá công ty làm bằng đường quản trị riêng.
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants FOR ALL TO app_rw
  USING (id = (SELECT app.tenant_id()))
  WITH CHECK (id = (SELECT app.tenant_id()));
GRANT SELECT ON tenants TO app_rw;
GRANT UPDATE (name) ON tenants TO app_rw;

-- Bảng dữ liệu của công ty (ví dụ: lịch hẹn). Mọi bảng dữ liệu khách có cột tenant_id mặc định lấy từ phiên: code quên ghi vẫn đúng công ty.
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.tenant_id() REFERENCES tenants (id),
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL,
  note text CHECK (length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id) -- để bảng con tham chiếu bằng khoá kép (tenant_id, booking_id), khoá ngoại không lộ dòng của công ty khác
);
CREATE INDEX bookings_tenant_starts_idx ON bookings (tenant_id, starts_at);
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bookings FOR ALL TO app_rw
  USING (tenant_id = (SELECT app.tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.tenant_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON bookings TO app_rw;

-- Dữ liệu riêng từng người trong công ty (ví dụ: ghi chú riêng): thêm điều kiện user_id.
CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.tenant_id() REFERENCES tenants (id),
  user_id uuid NOT NULL DEFAULT app.user_id(),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_tenant_user_idx ON notes (tenant_id, user_id);
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON notes FOR ALL TO app_rw
  USING (tenant_id = (SELECT app.tenant_id()) AND user_id = (SELECT app.user_id()))
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND user_id = (SELECT app.user_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO app_rw;

-- Không cấp TRUNCATE, REFERENCES, TRIGGER cho app_rw: RLS không chặn TRUNCATE và REFERENCES.
-- View khách (nếu có) phải tạo WITH (security_invoker = true); hàm SECURITY DEFINER bỏ qua RLS nên không dùng.
