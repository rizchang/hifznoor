import sys
import json
import urllib.request
import ssl

def extract_lines():
    print("Reading UthmaniScriptQuran.doc to extract page lines...")
    with open('UthmaniScriptQuran.doc', 'rb') as f:
        content = f.read()

    # Find the alignment of the UTF-16LE text stream
    align = -1
    for i in range(len(content) - 1):
        if content[i+1] == 0x06 and content[i] in (0x27, 0x44, 0x45, 0x49):
            align = i % 2
            break
    if align == -1:
        align = 0
    print(f"Alignment offset: {align}")

    text = content[align:].decode('utf-16le', errors='ignore')
    raw_blocks = text.split('\x0c')
    
    quran_pages_db = {}
    for page_num in range(1, 605):
        block_idx = page_num - 1
        if block_idx >= len(raw_blocks):
            break
            
        block_text = raw_blocks[block_idx]
        block_text_fixed = block_text.replace('\x0b', '\n').replace('\r', '\n')
        raw_lines = block_text_fixed.split('\n')
        cleaned_lines = []
        for line in raw_lines:
            line_clean = line.strip()
            line_clean = ''.join(c for c in line_clean if 0x0600 <= ord(c) <= 0x06ff or c in ' ' or ord(c) in (0xfd3e, 0xfd3f) or 0x0030 <= ord(c) <= 0x0039)
            line_clean = line_clean.strip()
            if line_clean:
                cleaned_lines.append(line_clean)
                
        # Slicing page to the exact Medina Mushaf page boundaries
        expected_lines = 8 if page_num in (1, 2) else 15
        cleaned_lines = cleaned_lines[:expected_lines]
        quran_pages_db[page_num] = cleaned_lines

    output_path = 'quran_page_lines.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(quran_pages_db, f, ensure_ascii=False, indent=2)
    print(f"Saved page lines to {output_path} successfully!")

def build_ayahs_db():
    print("Fetching entire Quran data from API to construct offline page ayahs database...")
    url = "https://api.alquran.cloud/v1/quran/quran-uthmani"
    
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, context=ctx) as response:
            raw_data = response.read()
    except Exception as e:
        print(f"Error fetching from API: {e}")
        return

    print("Parsing Quran JSON and grouping by page...")
    json_data = json.loads(raw_data.decode('utf-8'))
    if json_data.get("code") != 200 or "data" not in json_data:
        print("Invalid API response format")
        return
        
    surahs = json_data["data"]["surahs"]
    pages_db = {str(i): [] for i in range(1, 605)}
    
    for surah in surahs:
        surah_metadata = {
            "number": surah.get("number"),
            "name": surah.get("name"),
            "englishName": surah.get("englishName"),
            "englishNameTranslation": surah.get("englishNameTranslation"),
            "revelationType": surah.get("revelationType"),
            "numberOfAyahs": len(surah.get("ayahs", []))
        }
        
        for ayah in surah.get("ayahs", []):
            page_num = str(ayah["page"])
            ayah_obj = {
                "number": ayah["number"],
                "text": ayah["text"],
                "numberInSurah": ayah["numberInSurah"],
                "juz": ayah["juz"],
                "manzil": ayah["manzil"],
                "page": ayah["page"],
                "ruku": ayah["ruku"],
                "hizbQuarter": ayah["hizbQuarter"],
                "sajda": ayah.get("sajda", False),
                "surah": surah_metadata
            }
            pages_db[page_num].append(ayah_obj)
            
    output_path = "quran_pages_db.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(pages_db, f, ensure_ascii=False, indent=2)
    print(f"Successfully generated local pages database at {output_path}!")

if __name__ == '__main__':
    extract_lines()
    build_ayahs_db()
