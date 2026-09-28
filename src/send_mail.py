#!/usr/bin/env python3
"""Skickar kvällssammanfattningen via Gmail/SMTP.

Läser smtp.json (gitignored) + out/digest.txt och out/kvallssammanfattning.html.

  python3 src/send_mail.py
  MAIL_SUBJECT="Eget ämne" python3 src/send_mail.py
  MAIL_DRY_RUN=1 python3 src/send_mail.py   # visa bara vad som skulle skickas
"""
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cfg_path = Path(os.environ.get("SMTP_CONFIG", ROOT / "smtp.json"))
digest_path = ROOT / "out" / "digest.txt"
html_path = ROOT / "out" / "kvallssammanfattning.html"

if not cfg_path.exists():
    sys.exit(
        f"Saknar {cfg_path}.\n"
        "Kopiera smtp.json.example → smtp.json och fyll i adress + app-lösenord."
    )

cfg = json.loads(cfg_path.read_text())
host = cfg.get("host", "smtp.gmail.com")
port = int(cfg.get("port", 587))
username = cfg["username"]
password = str(cfg["password"]).replace(" ", "")  # Gmail visar app-lösenord i grupper om 4
sender = cfg.get("from", username)
recipients = cfg.get("to") or [username]

if not digest_path.exists():
    sys.exit(f"Saknar {digest_path} — kör `npm run collect` först.")

digest = digest_path.read_text().strip()
first_line = digest.splitlines()[0] if digest else "Infomentor"
subject = os.environ.get("MAIL_SUBJECT") or first_line

msg = EmailMessage()
msg["From"] = sender
msg["To"] = ", ".join(recipients)
msg["Subject"] = subject
msg.set_content(digest)
if html_path.exists():
    msg.add_alternative(html_path.read_text(), subtype="html")

if os.environ.get("MAIL_DRY_RUN"):
    print(f"[dry-run] skulle skicka till: {', '.join(recipients)}")
    print(f"[dry-run] ämne: {subject}")
    print(f"[dry-run] text {len(digest)} tecken, html {'ja' if html_path.exists() else 'nej'}")
    sys.exit(0)

context = ssl.create_default_context()
print(f"Ansluter till {host}:{port} som {username} …")
with smtplib.SMTP(host, port, timeout=30) as server:
    server.ehlo()
    server.starttls(context=context)
    server.ehlo()
    server.login(username, password)
    server.send_message(msg)

print(f"✅ Mejl skickat till {', '.join(recipients)} — ämne: {subject}")
