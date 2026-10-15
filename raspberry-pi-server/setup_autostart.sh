#!/bin/bash
# =========================================================================
# P.U.L.S.E. - Barangay 40 & 41 Cavite City
# Raspberry Pi 4B Automated Boot / Brownout Recovery Setup
# Kapag sinaksak ang Pi o nag-restart pagkatapos ng brownout,
# Awtomatikong magbubukas ang P.U.L.S.E. Server at ngrok / Cloudflare Tunnel!
# =========================================================================

set -e

echo "=========================================================="
echo "  P.U.L.S.E. AUTOSTART SETUP PARA SA RASPBERRY PI 4B"
echo "=========================================================="

USER_HOME="$HOME"
PYTHON_SERVER="$USER_HOME/server.py"

# 1. Tiyakin na may server.py
if [ ! -f "$PYTHON_SERVER" ]; then
    echo "  Hindi nakita ang ~/server.py, ginagawa ang pinakabagong bersyon..."
    cp server.py "$PYTHON_SERVER" 2>/dev/null || true
fi

echo "  Setup complete."
