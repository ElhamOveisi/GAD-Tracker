"""Convert an IFC into the dashboard's model files. Used by the server's "Upload new IFC".

Usage: python tools/build_model.py MODEL.ifc OUTPUT_FOLDER
Writes OUTPUT_FOLDER/model.bin and OUTPUT_FOLDER/meta.json and prints progress lines
starting with "STEP " so the server can show them.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import convert_model

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: build_model.py MODEL.ifc OUTPUT_FOLDER')
    n = convert_model(sys.argv[1], sys.argv[2], log=lambda s: print('STEP ' + s, flush=True))
    print(f'PANELS {n}', flush=True)
