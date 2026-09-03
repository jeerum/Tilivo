# OCR / extraction

- `OcrProvider` liides olemas; `NoopOcrProvider` tagastab "pole saadaval"
  (OCR-001) ega väljasta fiktiivseid väärtusi.
- Ekstraheerimisread: `field_name`, `value`, `confidence`, `source`,
  `source_region`; append-only.
- Structured XML confidence = 1.0 / source STRUCTURED_XML; OCR-i ei rakendata.
- Ekstraheeritud väärtused on sisend; lõplik tõde tekib review/approve/post
  raames.
