# Supper Rotation

A dinner planner for the two of you, running on a computer at home. It needs Node 18 or newer and has no other dependencies.

## Start it

Double-click `start.bat`, or run:

    node server.js

The window prints two addresses:

- `http://localhost:3000` works on this computer.
- `http://192.168.x.x:3000` works on phones and laptops on your home Wi-Fi. Bookmark it, or use "Add to Home Screen" on your phone.

The first time you start it, Windows may ask whether Node.js can use the network. Allow it on **private networks** so other devices can connect.

Your meals and plan are saved in `data/supper.json`. Back that file up if you care about it.

## Connect Ollama (on the other laptop)

1. Make Ollama listen on your network: set the environment variable `OLLAMA_HOST=0.0.0.0`, then quit and restart Ollama.
   On Windows: System Properties → Environment Variables → New user variable.
2. Allow port 11434 through that laptop's firewall on private networks.
3. Pull a model if you haven't already, for example `ollama pull llama3.1`.
4. In the app, open **Settings**, enter `http://<that laptop's IP>:11434`, click **Test connection**, pick a model, and click **Save**.

You can also set it at startup: `set OLLAMA_URL=http://192.168.1.50:11434` then `node server.js`.

## Recipes

- Paste a recipe link when you add or edit a meal. The app reads the ingredients and steps from the page, so you can view them in the app with a checkable ingredient list. This works with most big recipe sites, like AllRecipes, NYT Cooking's public pages, Serious Eats, Budget Bytes, and most food blogs.
- If a site blocks it, or the meal has no link, click **Have Ollama write one** in the recipe view.

## Change the port

    set PORT=8080
    node server.js
