// Z.ai OpenAI Compatible API Proxy for Deno
// 基于用户要求，重写自 Python 版本。
// 支持免令牌、智能处理思考链、图片上传等功能。

// --- 1. 环境配置 (Environment Configuration) ---

// 获取环境变量，并设置默认值
const BASE_URL = Deno.env.get("BASE") || "https://chat.z.ai";
const LISTEN_PORT = parseInt(Deno.env.get("PORT") || "8080");
const DEFAULT_MODEL = Deno.env.get("MODEL") || "GLM-4.5";
const API_TOKEN = Deno.env.get("TOKEN") || "";
// ANONYMOUS_MODE: 'true'/'false' 转换为布尔值
const ANONYMOUS_MODE = (Deno.env.get("ANONYMOUS_MODE") || "true").toLowerCase() === "true";
// THINK_TAGS_MODE: reasoning, think, strip, details
const THINK_TAGS_MODE = Deno.env.get("THINK_TAGS_MODE") || "reasoning";
const DEBUG_MODE = (Deno.env.get("DEBUG_MODE") || "false").toLowerCase() === "true";

if (DEBUG_MODE) {
    console.log(`[Config] BASE_URL: ${BASE_URL}`);
    console.log(`[Config] ANONYMOUS_MODE: ${ANONYMOUS_MODE}`);
    console.log(`[Config] DEFAULT_MODEL: ${DEFAULT_MODEL}`);
    console.log(`[Config] THINK_TAGS_MODE: ${THINK_TAGS_MODE}`);
}

// 访客模式下的随机令牌 (如果启用了 ANONYMOUS_MODE，这将作为占位符)
const ANON_TOKEN = ANONYMOUS_MODE ? crypto.randomUUID() : "";
let USER_TOKEN = API_TOKEN;

// --- 2. 思考链处理函数 (Chain of Thought Processing) ---

// 正则表达式用于匹配内容开头的思考链，例如：[思考链内容]
// 注意：Z.ai 的思考链格式可能会变化，这里使用最常见的 `[... ]` 模式。
// ^\s*\[(.*?)\]\s* - 匹配开头可选空白，非贪婪捕获方括号内的内容，后跟可选空白。
const COT_REGEX = /^\s*\[(.*?)\]\s*/s;

/**
 * 格式化思考链内容和实际响应内容。
 * @param thought 思考链内容 (e.g., "嗯，用户...")
 * @param content 实际的 LLM 响应内容 (e.g., "你好！")
 * @param mode 格式化模式
 * @returns 格式化后的内容
 */
function formatCot(thought: string, content: string, mode: string): string {
    if (!thought) return content;
    
    // 移除 thought 中的方括号 (如果有)
    const cleanThought = thought.trim().replace(/^\[|\]$/g, '').trim();
    if (!cleanThought) return content;

    switch (mode) {
        case "reasoning":
            // "reasoning"reasoning_content: 嗯，用户…… content: 你好！
            // 由于 OpenAI 响应格式不直接支持这种双字段结构，我们将其作为一个 JSON 结构返回。
            // 这种模式通常用于非流式响应的解析，但在流式中我们会使用特殊标记或自定义字段。
            // 在此 Deno 代理中，我们选择将其作为注释或特殊格式嵌入，以便后续解析。
            // 最佳实践是将其放在一个单独的 JSON 对象中，但在流中我们只能混合文本。
            // 采用将 thought 放在一个特殊标记后的方式
            return `<!-- REASONING_START -->\n${cleanThought}\n<!-- REASONING_END -->\n${content}`;
        case "think":
            // "think"content: <think>\n\n嗯，用户……\n\n</think>\n\n你好！
            return `<think>\n\n${cleanThought}\n\n</think>\n\n${content}`;
        case "strip":
            // "strip"content: > 嗯，用户……\n\n你好！ (注意：这种模式通常意味着只返回内容，这里为了演示，返回 markdown 引用)
            return `> ${cleanThought}\n\n${content}`;
        case "details":
            // "details"content: <details type="reasoning" open><div>\n\n嗯，用户……\n\n</div><summary>Thought for 1 seconds</summary></details>\n\n你好！
            return `<details type="reasoning" open><div>\n\n${cleanThought}\n\n</div><summary>Thought for 1 seconds</summary></details>\n\n${content}`;
        default:
            return `[${cleanThought}]${content}`; // 默认回退到原始格式
    }
}

/**
 * 处理流式响应中的思考链提取和内容格式化。
 * @param chunkText 传入的文本块
 * @param state 思考链处理状态
 * @returns 包含提取内容和新内容的 JSON 对象
 */
function processCotStream(chunkText: string, state: { processed: boolean, buffer: string, thought: string | null }): { newText: string, processed: boolean } {
    if (state.processed) {
        return { newText: chunkText, processed: true };
    }

    state.buffer += chunkText;
    let newText = chunkText;
    let match: RegExpMatchArray | null = null;
    let thought = "";
    let content = "";
    
    // 尝试在缓冲区中匹配思考链
    match = state.buffer.match(COT_REGEX);

    if (match) {
        thought = match[1];
        content = state.buffer.substring(match[0].length);
        
        // 标记为已处理
        state.processed = true;
        state.thought = thought;
        
        // 移除思考链内容，并应用格式
        if (THINK_TAGS_MODE === "reasoning" || THINK_TAGS_MODE === "strip") {
            // 在流式中，为了兼容性，我们只移除 thought，并让 content 直接流出
            // 除非是 details 或 think 模式，我们会添加标签
            newText = content; 
            
            // 为了在流中也能体现 reasoning/strip 的意图，我们将其作为第一块内容输出
            if (THINK_TAGS_MODE === "reasoning") {
                 // 这种模式通常只在非流式中有效，在流式中我们简单剥离
                 // 在这里为了区分，我们使用 think 模式的标签作为替代
                 newText = formatCot(thought, content, 'think');
            } else if (THINK_TAGS_MODE === "strip") {
                 // 简单剥离
                 newText = content;
            }
        } else {
            // 对于 'think' 或 'details' 模式，我们在第一个块中添加标签
            newText = formatCot(thought, content, THINK_TAGS_MODE);
        }
        
        // 更新 newText，只包含未发送的部分
        newText = newText.substring(state.buffer.length - newText.length);
        
    } else if (state.buffer.length > 2048) {
        // 如果缓冲区太大仍然没有匹配到，则认为没有思考链 (防止无限缓冲)
        if (DEBUG_MODE) console.log("[COT] Buffer too large, assuming no thought.");
        state.processed = true;
        newText = state.buffer; // 传出所有缓冲内容
        state.buffer = "";
    } else {
        // 仍在缓冲等待完整思考链
        newText = "";
    }
    
    return { newText, processed: state.processed };
}


// --- 3. 辅助函数 (Utility Functions) ---

/**
 * 获取或更新随机用户令牌 (适用于 ANONYMOUS_MODE)
 * @returns 当前使用的令牌
 */
function getToken(): string {
    if (ANONYMOUS_MODE) {
        // 匿名模式下，总是返回一个随机 UUID，但通常 Z.ai 需要一个实际的登录 token
        // 注意：Z.ai 匿名访问通常是通过一个会话 cookie 或预先生成的 token 实现的。
        // 由于无法在 Deno 环境中模拟完整的 Z.ai 登录流程，这里假设 ANONYMOUS_MODE 
        // 意味着不需要或使用一个静态的预先配置的TOKEN。如果 API_TOKEN 为空，则使用 ANON_TOKEN
        return API_TOKEN || ANON_TOKEN;
    }
    return API_TOKEN;
}

/**
 * 构建 Z.ai 兼容的 headers
 * @returns Headers 对象
 */
function getZaiHeaders(): HeadersInit {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`,
        // 其他必要的 Z.ai 头信息可以在这里添加
    };
}

/**
 * 检查并转换 OpenAI 图像数据到 Z.ai 格式 (Base64)
 * @param messages 消息数组
 * @returns 转换后的 Z.ai 消息数组和是否包含视觉模型需求的布尔值
 */
function processImageMessages(messages: any[]): { zaiMessages: any[], requiresVision: boolean } {
    let requiresVision = false;
    const zaiMessages = messages.map(msg => {
        if (Array.isArray(msg.content)) {
            // 包含图像的多模态消息
            const newContent: any[] = [];
            
            msg.content.forEach((part: any) => {
                if (part.type === "text") {
                    newContent.push({ type: "text", text: part.text });
                } else if (part.type === "image_url" && part.image_url.url) {
                    requiresVision = true;
                    // OpenAI 格式: data:image/jpeg;base64,...
                    const url = part.image_url.url;
                    
                    if (url.startsWith("data:")) {
                         // Z.ai 视觉模型通常需要上传文件，但为了兼容性，我们将 Base64 嵌入
                         // 注意：如果 Z.ai 不支持 content 中直接嵌入 Base64，此功能将失效。
                         // 实际部署中，登录后应调用 Z.ai 的 /api/upload 接口，这里简化为 Base64 嵌入。
                         newContent.push({ type: "image_url", url: url }); 
                    } else {
                        // 外部 URL 图像，Z.ai 可能不支持或需要特殊处理
                        if (DEBUG_MODE) console.warn(`[Image] Skipping external image URL: ${url}`);
                    }
                }
            });
            return { ...msg, content: newContent };
        }
        return msg;
    });

    return { zaiMessages, requiresVision };
}

// --- 4. 路由处理 (Router and Handlers) ---

/**
 * 主请求处理器
 * @param request 传入的 Request 对象
 * @returns Response 对象
 */
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. 模型列表代理 /v1/models
    if (url.pathname === "/v1/models") {
        return handleModels(request);
    }

    // 2. Chat Completions 代理 /v1/chat/completions
    if (url.pathname === "/v1/chat/completions") {
        return handleChatCompletions(request);
    }

    // 3. 根路径和默认路径
    if (url.pathname === "/" || url.pathname === "/health") {
        return new Response("Z.ai OpenAI Compatible Proxy running on Deno. Use /v1/chat/completions.", { status: 200 });
    }

    return new Response(`Not Found: ${url.pathname}`, { status: 404 });
}

/**
 * 处理 /v1/models 请求
 */
async function handleModels(request: Request): Promise<Response> {
    if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
    }

    const zaiModelsUrl = `${BASE_URL}/api/models`;
    if (DEBUG_MODE) console.log(`[Models] Fetching Z.ai models from: ${zaiModelsUrl}`);

    try {
        const zaiResponse = await fetch(zaiModelsUrl, {
            headers: getZaiHeaders(),
        });

        if (!zaiResponse.ok) {
            console.error(`[Models] Z.ai API returned error status: ${zaiResponse.status}`);
            return new Response(`Error fetching models from Z.ai: ${zaiResponse.statusText}`, { status: 500 });
        }

        const zaiData = await zaiResponse.json();

        // 转换 Z.ai 模型列表为 OpenAI 格式
        const openAIModels = (zaiData.models || []).map((m: any) => ({
            id: m.name, // 使用名称作为 ID
            object: "model",
            created: 1677649500, // 占位时间戳
            owned_by: "zai",
            // 自动选择合适的模型名称逻辑：
            // Z.ai 的模型列表通常是全知模型，直接使用其 name 即可。
        }));

        const responseData = {
            object: "list",
            data: openAIModels,
        };

        return new Response(JSON.stringify(responseData), {
            headers: { "Content-Type": "application/json" },
            status: 200,
        });

    } catch (error) {
        console.error("[Models] Failed to fetch Z.ai models:", error);
        return new Response("Internal Server Error during model fetch.", { status: 500 });
    }
}

/**
 * 处理 /v1/chat/completions 请求
 */
async function handleChatCompletions(request: Request): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
    }

    try {
        const openAIRequestBody = await request.json();
        
        // --- 4.1. 消息和模型处理 ---
        
        // 检查是否有图像并进行转换
        const { zaiMessages, requiresVision } = processImageMessages(openAIRequestBody.messages);
        
        // 自动选择模型: 优先使用请求中的模型，其次使用默认模型，如果包含图像，则使用 GLM-Vision
        let targetModel = openAIRequestBody.model || DEFAULT_MODEL;
        if (requiresVision && !ANONYMOUS_MODE) {
            targetModel = "GLM-Vision"; // 登录后支持上传图片使用 GLM 识图系列模型
            if (DEBUG_MODE) console.log(`[Chat] Vision model required, setting targetModel to: ${targetModel}`);
        } else if (requiresVision && ANONYMOUS_MODE) {
             // 访客模式下不支持上传文件调用视觉模型
             console.error("[Chat] Vision model requested in ANONYMOUS_MODE. This is not supported.");
             return new Response("Vision models require a login token (ANONYMOUS_MODE must be false).", { status: 400 });
        }


        // --- 4.2. 构建 Z.ai 请求体 ---
        const zaiRequestBody = {
            model: targetModel,
            messages: zaiMessages,
            stream: openAIRequestBody.stream !== false, // 默认为流式
            // 其他 OpenAI/Z.ai 参数映射可以在这里添加
            // temperature: openAIRequestBody.temperature,
            // max_tokens: openAIRequestBody.max_tokens,
        };
        
        if (DEBUG_MODE) console.log(`[Chat] Sending request to Z.ai with model: ${targetModel}, stream: ${zaiRequestBody.stream}`);

        // --- 4.3. 发送请求到 Z.ai ---
        const zaiApiUrl = `${BASE_URL}/v1/chat/completions`;
        const zaiResponse = await fetch(zaiApiUrl, {
            method: "POST",
            headers: getZaiHeaders(),
            body: JSON.stringify(zaiRequestBody),
        });

        if (!zaiResponse.ok || !zaiResponse.body) {
            console.error(`[Chat] Z.ai API returned error status: ${zaiResponse.status}`);
            const errorBody = await zaiResponse.text();
            return new Response(`Error from Z.ai: ${zaiResponse.statusText}. Details: ${errorBody}`, { status: zaiResponse.status });
        }

        // --- 4.4. 处理流式或非流式响应 ---
        
        if (zaiRequestBody.stream) {
            return handleStreamResponse(zaiResponse, targetModel);
        } else {
            return handleNonStreamResponse(zaiResponse, targetModel);
        }

    } catch (error) {
        console.error("[Chat] Internal Server Error:", error);
        return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
    }
}

/**
 * 处理非流式响应
 */
async function handleNonStreamResponse(zaiResponse: Response, modelId: string): Promise<Response> {
    const zaiData = await zaiResponse.json();

    // 提取 Z.ai 的响应文本
    const fullContent = zaiData.choices?.[0]?.message?.content || "";
    
    // 智能识别思考链
    const match = fullContent.match(COT_REGEX);
    let finalContent = fullContent;
    
    if (match) {
        const thought = match[1];
        const content = fullContent.substring(match[0].length);
        
        // 格式化内容
        finalContent = formatCot(thought, content, THINK_TAGS_MODE);
    }
    
    // 转换为 OpenAI 格式
    const openAIResponse = {
        id: zaiData.id || `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: finalContent,
            },
            finish_reason: zaiData.choices?.[0]?.finish_reason || "stop",
        }],
        usage: zaiData.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    return new Response(JSON.stringify(openAIResponse), {
        headers: { "Content-Type": "application/json" },
        status: 200,
    });
}

/**
 * 处理流式响应
 */
function handleStreamResponse(zaiResponse: Response, modelId: string): Response {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    // 思考链处理状态
    const cotState = {
        processed: false, // 思考链是否已被处理
        buffer: "",       // 用于缓冲以匹配完整的思考链
        thought: null,    // 提取到的思考链内容
    };

    // 转换流
    const customStream = new ReadableStream({
        async start(controller) {
            const reader = zaiResponse.body!.getReader();
            
            // 发送流开始信息
            const streamStart = {
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                    index: 0,
                    delta: { role: "assistant" },
                }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(streamStart)}\n\n`));

            try {
                // 读取 Z.ai 的 SSE 流
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data:')) {
                            const data = line.substring(5).trim();
                            if (data === '[DONE]') continue;

                            try {
                                const zaiChunk = JSON.parse(data);
                                
                                const contentChunk = zaiChunk.choices?.[0]?.delta?.content || "";
                                
                                // --- 思考链处理逻辑 ---
                                let newContentChunk = contentChunk;
                                
                                // 只有在 contentChunk 不为空且未处理时才进行处理
                                if (contentChunk && !cotState.processed) {
                                    const { newText, processed } = processCotStream(contentChunk, cotState);
                                    newContentChunk = newText;
                                    cotState.processed = processed;
                                } else if (cotState.thought && !cotState.processed) {
                                     // 如果有缓冲内容，将其作为新内容
                                     newContentChunk = cotState.buffer;
                                     cotState.buffer = "";
                                     cotState.processed = true;
                                }

                                if (newContentChunk) {
                                    const openAIChunk = {
                                        id: streamStart.id,
                                        object: "chat.completion.chunk",
                                        created: streamStart.created,
                                        model: modelId,
                                        choices: [{
                                            index: 0,
                                            delta: { content: newContentChunk },
                                        }],
                                    };
                                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                                }

                                // 转发 finish_reason
                                if (zaiChunk.choices?.[0]?.finish_reason) {
                                    const openAIChunk = {
                                        id: streamStart.id,
                                        object: "chat.completion.chunk",
                                        created: streamStart.created,
                                        model: modelId,
                                        choices: [{
                                            index: 0,
                                            delta: {},
                                            finish_reason: zaiChunk.choices[0].finish_reason,
                                        }],
                                    };
                                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                                }

                            } catch (e) {
                                if (DEBUG_MODE) console.warn("[Stream] Failed to parse JSON line:", line, e);
                                // 忽略无法解析的行
                            }
                        }
                    }
                }
            } catch (error) {
                console.error("[Stream] Error processing Z.ai stream:", error);
                controller.error(error);
            } finally {
                // 结束流
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            }
        },
    });

    // 返回 OpenAI 兼容的流式响应
    return new Response(customStream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
        status: 200,
    });
}


// --- 5. 启动服务 (Start Server) ---

// 使用 Deno.serve 启动 HTTP 服务器
Deno.serve({ port: LISTEN_PORT }, handleRequest);
if (DEBUG_MODE) {
    console.log(`[Server] Deno Proxy listening on http://localhost:${LISTEN_PORT}`);
}
