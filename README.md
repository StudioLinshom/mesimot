# משימות · Mesimot

ניהול משימות בסגנון Planner לפרויקטים, לקוחות ושותפים.
אפליקציית web סטטית (GitHub Pages) עם Supabase כמסד נתונים, התחברות והרשאות.

## מה יש בפנים
- **פרויקטים**: לכל לקוח / תחום לוח משלו, עם צבע
- **לוח בסגנון Planner**: דליים (עמודות) שאפשר להוסיף, לשנות שם, לגרור ולמחוק. כרטיסים נגררים בין עמודות
- **קיבוץ** לפי דליים / התקדמות / אחראי / עדיפות
- **כרטיס משימה**: אחראי, דלי, התקדמות, עדיפות, תאריך יעד, תיאור, רשימת תיוג
- **המשימות שלי**: כל מה שמשויך אליי מכל הפרויקטים: באיחור / היום / השבוע / מאוחר יותר
- **שיתוף**: הזמנת שותף לפרויקט לפי מייל. כל שותף רואה רק את הפרויקטים שהוזמן אליהם
- **עדכונים בזמן אמת** בין שותפים
- עברית מלאה (RTL), מצב כהה, מותאם לטלפון, ואפשר להוסיף למסך הבית

## מבנה
```
index.html            מעטפת
config.js             כתובת Supabase + anon key
assets/app.js         כל הלוגיקה (vanilla JS, בלי build)
assets/styles.css     עיצוב
supabase/schema.sql   טבלאות, הרשאות (RLS), טריגרים ופונקציות
```

## הקמה
1. **Supabase**: פרויקט חדש → SQL Editor → להריץ את `supabase/schema.sql`
2. **Authentication → URL Configuration**:
   - Site URL: `https://studiolinshom.github.io/mesimot/`
   - Redirect URLs: `https://studiolinshom.github.io/mesimot/**`
3. **Project Settings → API**: להעתיק את Project URL ואת ה-anon public key ל-`config.js`
4. **GitHub → Settings → Pages**: Source = `main` / root

### כניסה עם Google (אופציונלי)
Supabase → Authentication → Providers → Google, ואז `ENABLE_GOOGLE_LOGIN = true` ב-`config.js`.

## אבטחה
ה-anon key גלוי בקוד וזה תקין: כל הגישה לנתונים עוברת דרך Row Level Security.
משתמש רואה ועורך רק פרויקטים שהוא חבר בהם, ורק מנהל פרויקט יכול להזמין או להסיר שותפים.
**לעולם לא להכניס לקוד את ה-`service_role` key.**

## פיתוח מקומי
```
python3 -m http.server 8000
```
ואז לפתוח http://localhost:8000 (צריך להוסיף את הכתובת ל-Redirect URLs ב-Supabase).
