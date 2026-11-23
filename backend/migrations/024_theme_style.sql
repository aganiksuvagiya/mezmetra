-- The design a restaurant gives its customer pages (Admin -> Appearance): one of five (see shared/styles.js). Colours stay in
-- theme_primary / theme_accent and work with every design.
ALTER TABLE vendors
  ADD COLUMN theme_style text NOT NULL DEFAULT 'classic'
    CHECK (theme_style IN ('classic', 'bistro', 'gallery', 'minimal', 'night'));
