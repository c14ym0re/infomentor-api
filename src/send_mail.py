#!/usr/bin/env python3
"""Skickar ett mejl via SMTP (Gmail/Workspace m.fl.).

Standard: skickar out/digest.txt som text + out/kvallssammanfattning.html som
HTML-alternativ. Allt kan styras med miljövariabler:

  MAIL_SUBJECT       ämne (annars första raden i texten)
  MAIL_BODY          brödtext direkt
  MAIL_BODY_FILE     fil med brödtext (annars out/digest.txt)
  MAIL_HTML_FILE     HTML-alternativ (annars out/kvallssammanfattning.html)
  MAIL_NO_HTML=1     skicka ingen HTML
  MAIL_TO            kommaseparerade mottagare (annars smtp.json:s "to")
  MAIL_DRY_RUN=1     visa bara vad som skulle skickas
  SMTP_CONFIG        sökväg till smtp.json
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

if os.environ.get("MAIL_TO"):
    recipients = [a.strip() for a in os.environ["MAIL_TO"].split(",") if a.strip()]
else:
    recipients = cfg.get("to") or [username]

# --- brödtext
if os.environ.get("MAIL_BODY") is not None:
    body = os.environ["MAIL_BODY"].strip()
else:
    body_file = Path(os.environ.get("MAIL_BODY_FILE", ROOT / "out" / "digest.txt"))
    if not body_file.exists():
        sys.exit(f"Saknar {body_file} — kör insamlingen först.")
    body = body_file.read_text().strip()

subject = os.environ.get("MAIL_SUBJECT") or (body.splitlines()[0] if body else "Infomentor")

# --- HTML-alternativ
html = None
if os.environ.get("MAIL_NO_HTML") != "1":
    html_file = Path(os.environ.get("MAIL_HTML_FILE", ROOT / "out" / "kvallssammanfattning.html"))
    if html_file.exists():
        html = html_file.read_text()

msg = EmailMessage()
msg["From"] = sender
msg["To"] = ", ".join(recipients)
msg["Subject"] = subject
msg.set_content(body)
if html:
    msg.add_alternative(html, subtype="html")

if os.environ.get("MAIL_DRY_RUN"):
    print(f"[dry-run] till: {', '.join(recipients)}")
    print(f"[dry-run] ämne: {subject}")
    print(f"[dry-run] text {len(body)} tecken, html {'ja' if html else 'nej'}")
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
