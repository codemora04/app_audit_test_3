// supabase.js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://nefakvxfrjzfynyicemc.supabase.co";

const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5lZmFrdnhmcmp6ZnlueWljZW1jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyMzk1NDQsImV4cCI6MjA4NjgxNTU0NH0.jX3-eF6PHGi7-sp97nYYyYbHGwXbH7IrjVdFctKn3dQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);