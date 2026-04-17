Show a summary of the current Stitch setup in this project.

1. Check if `.stitch/` exists. If not, say "No bridges generated yet."

2. If it exists, list every file inside `.stitch/bridges/` and show:
   - Bridge name
   - Source language (inferred from file extension)
   - Target language (inferred from file extension)
   - File size

3. Check `.stitch/.venv/` — if present, show Python version inside it:
   `.stitch/.venv/bin/python --version`

4. Show which bridge pairs are available in this repo's `bridges/` directory
   (read the directory listing of `bridges/`).

5. Print a quick-start reminder:
   "To generate a new bridge: /stitch <source> <target> <name> '<capability>' '<deps>'"
   Example: /stitch typescript python image_processor 'resize images' 'Pillow'
