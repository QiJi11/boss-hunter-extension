(function(root) {
  function bytesFromDataUrl(dataUrl) {
    var raw = String(dataUrl || '');
    var commaIndex = raw.indexOf(',');
    if (commaIndex < 0 || raw.slice(0, commaIndex).indexOf(';base64') < 0) return null;
    var binary = atob(raw.slice(commaIndex + 1));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function resumeImageBytes(image) {
    if (!image) return null;
    var previewBytes = bytesFromDataUrl(image.fullSrc || image.src);
    if (previewBytes) return previewBytes;
    if (image.data instanceof ArrayBuffer) return new Uint8Array(image.data);
    if (ArrayBuffer.isView(image.data)) {
      return new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    }
    if (Array.isArray(image.data)) return new Uint8Array(image.data);
    if (image.data && typeof image.data.arrayBuffer === 'function') {
      return new Uint8Array(await image.data.arrayBuffer());
    }
    return null;
  }

  async function stableResumeImageId(image) {
    var bytes = await resumeImageBytes(image);
    if (!bytes || !bytes.byteLength) return '';
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    var hex = Array.from(new Uint8Array(digest)).map(function(byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
    return 'sha256-' + hex;
  }

  async function resumeImageConsentKey(image) {
    var imageId = await stableResumeImageId(image);
    if (!imageId) return '';
    return imageId + '|' + String(image && image.name || '图片简历');
  }

  async function resumeImageConsentKeys(images) {
    return Promise.all((Array.isArray(images) ? images : []).map(resumeImageConsentKey));
  }

  root.stableResumeImageId = stableResumeImageId;
  root.resumeImageBytes = resumeImageBytes;
  root.resumeImageConsentKey = resumeImageConsentKey;
  root.resumeImageConsentKeys = resumeImageConsentKeys;
})(typeof globalThis !== 'undefined' ? globalThis : this);
