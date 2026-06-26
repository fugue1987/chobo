-- 在宿主:docker exec -i postgres18 psql -U pgadmin -d default_db < chobo-init-db.sql
-- 与 five_elements 库隔离;密码 fugue 改成强随机串
CREATE USER chobo WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE chobo OWNER chobo;
\connect chobo
GRANT ALL ON SCHEMA public TO chobo;
-- 建表/索引由 CRM 启动时自迁移(0001_init + 0002_account),此处只建库+账号
