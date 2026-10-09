import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImportReport } from '../src/renderer/src/App'
import type { ImportResult } from '../src/shared/models'

const result: ImportResult = { jobId: '隔离任务', fileName: '隔离.json', fileType: 'JSON', status: 'failed',
  recognizedCount: 0, importedCount: 0, updatedCount: 0, duplicateCount: 0, invalidCount: 0, errors: [] }

describe('文件导入的明确失败与提交后提示', () => {
  it('来源冲突原因直接展示，不能只留在折叠详情', () => {
    const reason = 'SOURCE_CONTENT_CONFLICT: 本来源未导入：归一化指纹相同，但原文不同。为保护来源真实性，未绑定、未覆盖或修改已有记录。'
    const html = renderToStaticMarkup(<ImportReport result={{ ...result, errors: [reason] }} />)
    expect(html).toContain('<p role="alert">' + reason + '</p>')
  })
  it.each(['CSV', 'TXT'] as const)('%s 的旧失败展示保持原样', fileType => {
    const html = renderToStaticMarkup(<ImportReport result={{ ...result, fileType, errors: ['旧格式错误'] }} />)
    expect(html).toContain('导入失败')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('role="status"')
  })
  it('提交后诊断异常保留成功状态并显示独立提示', () => {
    const reason = 'POST_COMMIT_DIAGNOSTIC_FAILED: 核心导入已提交，导入后诊断未完成。'
    const html = renderToStaticMarkup(<ImportReport result={{ ...result, status: 'success', importedCount: 1, errors: [reason] }} />)
    expect(html).toContain('导入成功')
    expect(html).toContain('<p role="status">' + reason + '</p>')
    expect(html).not.toContain('role="alert"')
  })
})
